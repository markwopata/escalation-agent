// Driver for Tier C reflection. Defaults to a 1-day window (daily cadence);
// override with --since / --until.
//
// Usage:
//   npm run reflect                       # since the last reflection (or 1 day ago)
//   npm run reflect -- --since 2026-04-01 # explicit window
//   npm run reflect -- --dry-run          # show inputs, don't call Opus
//   npm run reflect -- --sample-nonflagged 30  # add N un-flagged messages for false-negative scan

import process from "node:process";
import { openDatabase, nowIso } from "./lib/db.mjs";
import {
  runReflection,
  buildReflectionUserMessage,
  REFLECTION_PROMPT_VERSION,
  REFLECTION_MODEL,
  normalizeProposalType,
} from "./lib/reflect.mjs";

function parseArgs(argv) {
  const args = {
    since: null,
    until: null,
    dryRun: false,
    sampleNonflagged: 0,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--since") args.since = argv[++i];
    else if (a === "--until") args.until = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--sample-nonflagged") args.sampleNonflagged = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node scripts/run-reflection.mjs [--since ISO] [--until ISO] [--sample-nonflagged N] [--dry-run]");
      process.exit(0);
    } else { console.error(`Unknown arg: ${a}`); process.exit(1); }
  }
  return args;
}

function defaultSince(db) {
  // Last reflection_run.window_end OR 1 day ago (daily cadence).
  const last = db.prepare("SELECT MAX(window_end) AS m FROM reflection_runs").get();
  if (last?.m) return last.m;
  return new Date(Date.now() - 86400000).toISOString();
}

function loadWindowData(db, args) {
  const since = args.since ?? defaultSince(db);
  const until = args.until ?? nowIso();

  const escalations = db.prepare(`
    SELECT e.*, v.full_name AS author_full_name, c.name AS channel_name
    FROM escalations e
    LEFT JOIN v_employees_with_slack v ON v.slack_user_id = e.author_slack_user_id
    LEFT JOIN channels c ON c.slack_channel_id = e.slack_channel_id
    WHERE e.created_at >= ? AND e.created_at <= ?
    ORDER BY e.max_severity DESC, e.last_evidence_at DESC
  `).all(since, until);

  const feedback = db.prepare(`
    SELECT * FROM exec_feedback
    WHERE created_at >= ? AND created_at <= ?
    ORDER BY created_at ASC
  `).all(since, until);

  // Exec interventions in window. We mark whether the agent escalated the
  // thread/channel of the intervention so Opus can flag false-negatives.
  const interventions = db.prepare(`
    SELECT i.id, i.exec_display_name, i.intervention_type, i.intervention_at,
           i.slack_channel_id, i.slack_ts, i.thread_ts, i.evidence_text,
           c.name AS channel_name,
           v.full_name AS author_full_name,
           CASE WHEN EXISTS (
             SELECT 1 FROM escalations e
             WHERE e.slack_channel_id = i.slack_channel_id
             AND e.created_at >= ? AND e.created_at <= ?
           ) THEN 1 ELSE 0 END AS agent_escalated_this_thread
    FROM ceo_interventions i
    LEFT JOIN channels c ON c.slack_channel_id = i.slack_channel_id
    LEFT JOIN v_employees_with_slack v ON v.slack_user_id = i.authored_by_slack_user_id
    WHERE i.intervention_at >= ? AND i.intervention_at <= ?
    ORDER BY i.intervention_at DESC
  `).all(since, until, since, until);

  let sampleNonFlagged = [];
  if (args.sampleNonflagged > 0) {
    sampleNonFlagged = db.prepare(`
      SELECT m.text, m.message_posted_at, m.author_username, c.name AS channel_name,
             v.full_name AS author_full_name
      FROM messages m
      JOIN channels c ON c.slack_channel_id = m.slack_channel_id
      LEFT JOIN v_employees_with_slack v ON v.slack_user_id = m.author_slack_user_id
      LEFT JOIN triage_runs t
        ON t.slack_channel_id = m.slack_channel_id
       AND t.slack_ts = m.slack_ts
       AND t.worth_deeper_look = 1
      WHERE m.message_posted_at >= ? AND m.message_posted_at <= ?
        AND t.id IS NULL
        AND LENGTH(m.text) > 30
      ORDER BY RANDOM()
      LIMIT ?
    `).all(since, until, Math.min(args.sampleNonflagged, 100));
  }

  return { since, until, escalations, feedback, interventions, sampleNonFlagged };
}

function persistRun(db, params, parsed, meta) {
  const result = db.prepare(`
    INSERT INTO reflection_runs (
      model, prompt_version, window_start, window_end,
      escalations_analyzed, feedback_analyzed, proposals_emitted,
      summary_text, full_response_json,
      input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
      ran_at, duration_ms
    ) VALUES (
      @model, @prompt_version, @window_start, @window_end,
      @escalations_analyzed, @feedback_analyzed, @proposals_emitted,
      @summary_text, @full_response_json,
      @input_tokens, @output_tokens, @cache_read, @cache_create,
      @ran_at, @duration_ms
    )
  `).run({
    model: meta.model,
    prompt_version: REFLECTION_PROMPT_VERSION,
    window_start: params.since,
    window_end: params.until,
    escalations_analyzed: params.escalations.length,
    feedback_analyzed: params.feedback.length,
    proposals_emitted: parsed.proposals.length,
    summary_text: parsed.window_summary,
    full_response_json: JSON.stringify(parsed),
    input_tokens: meta.usage?.input_tokens ?? null,
    output_tokens: meta.usage?.output_tokens ?? null,
    cache_read: meta.usage?.cache_read_input_tokens ?? null,
    cache_create: meta.usage?.cache_creation_input_tokens ?? null,
    ran_at: nowIso(),
    duration_ms: meta.duration_ms ?? null,
  });
  const reflectionId = result.lastInsertRowid;
  for (const p of parsed.proposals) {
    db.prepare(`
      INSERT INTO criterion_proposals (
        reflection_run_id, proposal_type, proposed_change, rationale,
        evidence_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      reflectionId,
      normalizeProposalType(p.proposal_type),
      p.proposed_change,
      p.rationale,
      JSON.stringify({
        escalation_ids: p.evidence_escalation_ids ?? [],
        feedback_ids: p.evidence_feedback_ids ?? [],
      }),
      nowIso(),
    );
  }
  return reflectionId;
}

async function main() {
  const args = parseArgs(process.argv);
  const db = openDatabase();
  const params = loadWindowData(db, args);
  console.log(`Window: ${params.since} → ${params.until}`);
  console.log(`Inputs: ${params.escalations.length} escalations, ${params.feedback.length} feedback, ${params.interventions.length} exec interventions, ${params.sampleNonFlagged.length} sampled non-flagged`);

  if (args.dryRun) {
    console.log("\n--- DRY RUN: prompt that would be sent to Opus ---\n");
    console.log(buildReflectionUserMessage({
      escalations: params.escalations,
      feedback: params.feedback,
      interventions: params.interventions,
      sampleNonFlagged: params.sampleNonFlagged,
      windowStart: params.since,
      windowEnd: params.until,
    }));
    return;
  }

  const { parsed, usage, model, duration_ms } = await runReflection({
    escalations: params.escalations,
    feedback: params.feedback,
    interventions: params.interventions,
    sampleNonFlagged: params.sampleNonFlagged,
    windowStart: params.since,
    windowEnd: params.until,
  });

  const reflectionId = persistRun(db, params, parsed, { model, usage, duration_ms });
  console.log(`\nReflection #${reflectionId} persisted with ${parsed.proposals.length} proposal(s).`);
  console.log("\n--- WINDOW SUMMARY ---");
  console.log(parsed.window_summary);
  console.log("\n--- PROPOSALS ---");
  parsed.proposals.forEach((p, i) => {
    console.log(`\n[${i + 1}] ${p.proposal_type}`);
    console.log(`    ${p.proposed_change}`);
    console.log(`    Why: ${p.rationale}`);
    if (p.evidence_escalation_ids?.length) console.log(`    Evidence escalations: ${p.evidence_escalation_ids.join(", ")}`);
    if (p.evidence_feedback_ids?.length) console.log(`    Evidence feedback: ${p.evidence_feedback_ids.join(", ")}`);
  });
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
}
