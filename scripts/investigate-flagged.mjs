// Drives Tier B investigation over Tier A flags that don't yet have an
// investigation row for the current investigation prompt version.
//
// Modes:
//   default              — calls Sonnet for each pending flag (needs ANTHROPIC_API_KEY)
//   --from-file <path>   — reads pre-computed investigations from JSON, persists them
//   --limit N
//   --dry-run            — print what would be sent

import process from "node:process";
import { readFileSync } from "node:fs";
import { openDatabase, nowIso } from "./lib/db.mjs";
import {
  investigateFlag,
  buildInitialUserMessage,
  INVESTIGATION_MODEL,
  INVESTIGATION_PROMPT_VERSION,
  InvestigationOutputSchema,
} from "./lib/investigate.mjs";
import { getExecFeedbackContextText } from "./lib/exec-feedback-context.mjs";

function parseArgs(argv) {
  const args = { mode: "live", limit: null, fromFile: null, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--from-file") { args.mode = "from-file"; args.fromFile = argv[++i]; }
    else if (a === "--limit") { args.limit = Number(argv[++i]); }
    else if (a === "--dry-run") { args.dryRun = true; }
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node scripts/investigate-flagged.mjs [--from-file path.json] [--limit N] [--dry-run]");
      process.exit(0);
    }
    else { console.error(`Unknown arg: ${a}`); process.exit(1); }
  }
  return args;
}

function loadTriageContext(db, triageRun) {
  const message = db.prepare(`
    SELECT * FROM messages
    WHERE slack_channel_id = ? AND slack_ts = ?
  `).get(triageRun.slack_channel_id, triageRun.slack_ts);
  const channel = db.prepare(`SELECT * FROM channels WHERE slack_channel_id = ?`).get(triageRun.slack_channel_id);
  const author = message?.author_slack_user_id
    ? db.prepare(`SELECT * FROM v_employees_with_slack WHERE slack_user_id = ?`).get(message.author_slack_user_id)
    : null;
  const exec_feedback_text = getExecFeedbackContextText(db);
  return { triageRun, message, channel, author, exec_feedback_text };
}

const INSERT_INVESTIGATION_SQL = `
INSERT OR REPLACE INTO investigations (
  triage_run_id, model, prompt_version,
  decision, severity, exec_summary, rationale,
  evidence_refs_json, recommended_actions_json, tools_used_json, full_response_json,
  input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
  ran_at, duration_ms
) VALUES (
  @triage_run_id, @model, @prompt_version,
  @decision, @severity, @exec_summary, @rationale,
  @evidence_refs_json, @recommended_actions_json, @tools_used_json, @full_response_json,
  @input_tokens, @output_tokens, @cache_read_input_tokens, @cache_creation_input_tokens,
  @ran_at, @duration_ms
)
`;

function persistInvestigation(db, triageRun, parsed, meta) {
  db.prepare(INSERT_INVESTIGATION_SQL).run({
    triage_run_id: triageRun.id,
    model: meta.model,
    prompt_version: INVESTIGATION_PROMPT_VERSION,
    decision: parsed.decision,
    severity: parsed.severity,
    exec_summary: parsed.exec_summary,
    rationale: parsed.rationale,
    evidence_refs_json: JSON.stringify(parsed.evidence_refs ?? {}),
    recommended_actions_json: JSON.stringify(parsed.recommended_actions ?? []),
    tools_used_json: JSON.stringify(meta.tools_used ?? null),
    full_response_json: JSON.stringify(parsed),
    input_tokens: meta.usage?.input_tokens ?? null,
    output_tokens: meta.usage?.output_tokens ?? null,
    cache_read_input_tokens: meta.usage?.cache_read_input_tokens ?? null,
    cache_creation_input_tokens: meta.usage?.cache_creation_input_tokens ?? null,
    ran_at: nowIso(),
    duration_ms: meta.duration_ms ?? null,
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const db = openDatabase();

  const pending = db.prepare(`
    SELECT t.*
    FROM triage_runs t
    LEFT JOIN investigations i
      ON i.triage_run_id = t.id
     AND i.prompt_version = ?
    WHERE t.worth_deeper_look = 1
      AND i.id IS NULL
    ORDER BY t.severity DESC, t.ran_at DESC
    ${args.limit ? `LIMIT ${Number(args.limit)}` : ""}
  `).all(INVESTIGATION_PROMPT_VERSION);

  console.log(`Pending: ${pending.length} flagged items without an ${INVESTIGATION_PROMPT_VERSION} run.`);

  if (args.mode === "from-file") {
    const payload = JSON.parse(readFileSync(args.fromFile, "utf8"));
    const results = payload.results ?? [];
    const byTriageId = new Map();
    for (const r of results) byTriageId.set(r.triage_run_id, r);

    let persisted = 0;
    const txn = db.transaction(() => {
      for (const t of pending) {
        const r = byTriageId.get(t.id);
        if (!r) continue;
        const parsed = InvestigationOutputSchema.parse(r.parsed);
        persistInvestigation(db, t, parsed, {
          model: r.model ?? "manual-prototype",
          usage: r.usage,
          duration_ms: r.duration_ms ?? null,
          tools_used: r.tools_used ?? null,
        });
        persisted += 1;
      }
    });
    txn();
    console.log(`Persisted ${persisted} investigations from file.`);
    return;
  }

  if (args.dryRun) {
    for (const t of pending.slice(0, args.limit ?? 3)) {
      const ctx = loadTriageContext(db, t);
      console.log("---");
      console.log(`triage_run_id=${t.id} channel=${t.slack_channel_id} ts=${t.slack_ts}`);
      console.log(buildInitialUserMessage(ctx));
    }
    return;
  }

  // Live Sonnet mode.
  let ok = 0, errors = 0;
  for (const t of pending) {
    const ctx = loadTriageContext(db, t);
    try {
      const { parsed, usage, duration_ms, model } = await investigateFlag(ctx, db);
      persistInvestigation(db, t, parsed, { model, usage, duration_ms });
      ok += 1;
      console.log(`[${ok}/${pending.length}] triage_run=${t.id} → ${parsed.decision.toUpperCase()} sev=${parsed.severity}`);
      console.log(`  exec_summary: ${parsed.exec_summary}`);
    } catch (err) {
      errors += 1;
      console.error(`Error on triage_run=${t.id}:`, err.message);
    }
  }
  console.log(`\nDone. ${ok} ok, ${errors} errors.`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
