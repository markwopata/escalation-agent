// Batch-mode driver for Tier A triage. Submits all pending messages as a
// single batch job (50% discount, 24h SLA), persists the batch_id, then
// poll-mode pulls and writes results.
//
// Usage:
//   npm run triage:batch -- submit         # submit all pending messages as one batch
//   npm run triage:batch -- poll           # check + persist any ended batches
//   npm run triage:batch -- list           # show pending batches
//
// Designed for nightly cron:
//   2am: triage:batch submit
//   6am: triage:batch poll
//   6:05: investigate:batch submit (similar pattern, not built here yet)
//   ...

import process from "node:process";
import { openDatabase, nowIso } from "./lib/db.mjs";
import {
  TRIAGE_MODEL,
  buildTriageUserContent,
  buildTriageResultSchema,
  getTriagePromptVersion,
} from "./lib/triage.mjs";
import { buildSystemPrompt } from "./lib/triage-prompt.mjs";
import { loadActiveCriterionCodes } from "./lib/triage-prompt.mjs";
import { buildRetrievalBundle, renderRetrievalBundle } from "./lib/triage-retrieval.mjs";
import {
  classifyAsStructuralNoise,
  loadCompiledSilenceRules,
  classifyAgainstDynamicRules,
} from "./lib/structural-filter.mjs";
import { estimateBudget, enforceCap, formatEstimate } from "./lib/cost-cap.mjs";
import { getExecFeedbackContextText } from "./lib/exec-feedback-context.mjs";
import {
  buildBatchRequest,
  submitTriageBatch,
  getBatchStatus,
  iterateBatchResults,
  extractTriageResultFromBatchRow,
} from "./lib/batch-triage.mjs";

function parseArgs(argv) {
  const args = { mode: argv[2] ?? "submit", cap: 250, forceOverCap: false };
  for (let i = 3; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--cap") args.cap = Number(argv[++i]);
    else if (a === "--force-over-cap") args.forceOverCap = true;
  }
  return args;
}

function elapsedHuman(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "in the future";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function loadFullContext(db, message) {
  const channel = db.prepare(`SELECT * FROM channels WHERE slack_channel_id = ?`).get(message.slack_channel_id);
  const author = message.author_slack_user_id
    ? db.prepare(`SELECT * FROM v_employees_with_slack WHERE slack_user_id = ?`).get(message.author_slack_user_id)
    : null;
  let mentions = [];
  if (message.mentions_user_ids_json) {
    const ids = JSON.parse(message.mentions_user_ids_json);
    if (ids.length) {
      const ph = ids.map(() => "?").join(",");
      mentions = db.prepare(`SELECT slack_user_id, full_name, is_corporate, employee_title FROM v_employees_with_slack WHERE slack_user_id IN (${ph})`).all(...ids);
      const found = new Set(mentions.map(m => m.slack_user_id));
      for (const id of ids) if (!found.has(id)) mentions.push({ slack_user_id: id });
    }
  }
  const recent = db.prepare(`
    SELECT m.text, m.message_posted_at, m.author_username, v.full_name, v.is_corporate
    FROM messages m
    LEFT JOIN v_employees_with_slack v ON v.slack_user_id = m.author_slack_user_id
    WHERE m.slack_channel_id = ? AND m.message_posted_at < ?
    ORDER BY m.message_posted_at DESC LIMIT 6
  `).all(message.slack_channel_id, message.message_posted_at ?? new Date().toISOString());
  const retrieval = buildRetrievalBundle(db, message);
  const retrieval_text = renderRetrievalBundle(retrieval);
  const exec_feedback_text = getExecFeedbackContextText(db);
  return {
    channel: channel ?? { name: message.slack_channel_id, channel_type: "?" },
    author: author ?? (message.author_slack_user_id ? { slack_user_id: message.author_slack_user_id, author_username: message.author_username } : null),
    mentions, recent, retrieval_text, exec_feedback_text,
    message: {
      text: message.text,
      message_posted_at: message.message_posted_at,
      elapsed_human: elapsedHuman(message.message_posted_at),
      is_bot: message.is_bot,
      reply_count: message.reply_count,
    },
  };
}

const INSERT_TRIAGE_SQL = `
INSERT OR REPLACE INTO triage_runs (
  slack_channel_id, slack_ts, model, prompt_version,
  worth_deeper_look, severity, primary_criterion, criteria_matched_json, reason,
  full_response_json,
  input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
  ran_at, duration_ms
) VALUES (
  @slack_channel_id, @slack_ts, @model, @prompt_version,
  @worth_deeper_look, @severity, @primary_criterion, @criteria_matched_json, @reason,
  @full_response_json,
  @input_tokens, @output_tokens, @cache_read, @cache_create,
  @ran_at, @duration_ms
)
`;

function persistTriage(db, channelId, slackTs, parsed, meta, promptVersion) {
  db.prepare(INSERT_TRIAGE_SQL).run({
    slack_channel_id: channelId,
    slack_ts: slackTs,
    model: meta.model,
    prompt_version: promptVersion,
    worth_deeper_look: parsed.worth_deeper_look ? 1 : 0,
    severity: parsed.severity,
    primary_criterion: parsed.primary_criterion,
    criteria_matched_json: JSON.stringify(parsed.criteria_matched ?? []),
    reason: parsed.reason,
    full_response_json: JSON.stringify(parsed),
    input_tokens: meta.usage?.input_tokens ?? null,
    output_tokens: meta.usage?.output_tokens ?? null,
    cache_read: meta.usage?.cache_read_input_tokens ?? null,
    cache_create: meta.usage?.cache_creation_input_tokens ?? null,
    ran_at: nowIso(),
    duration_ms: null,
  });
}

async function submitMode(args) {
  const db = openDatabase();
  const promptVersion = getTriagePromptVersion(db);

  // Guard: refuse to submit while a prior batch at the same prompt_version
  // is still in flight. Otherwise hourly ticks can re-submit the same
  // pending messages before the prior batch has persisted (we observed
  // a $17 wasted duplicate Front catch-up via this race).
  const inFlight = db.prepare(`
    SELECT batch_id FROM batch_jobs
    WHERE job_type = 'triage' AND status = 'submitted' AND prompt_version = ?
    ORDER BY id DESC LIMIT 1
  `).get(promptVersion);
  if (inFlight) {
    console.log(`Skipping submit — Slack batch ${inFlight.batch_id} already in flight at this prompt version.`);
    return;
  }

  const { prompt: systemPrompt } = buildSystemPrompt(db);
  const schema = buildTriageResultSchema(loadActiveCriterionCodes(db));

  const pending = db.prepare(`
    SELECT m.*
    FROM messages m
    LEFT JOIN triage_runs t
      ON t.slack_channel_id = m.slack_channel_id
     AND t.slack_ts = m.slack_ts
     AND t.prompt_version = ?
    WHERE t.id IS NULL
    ORDER BY m.message_posted_at DESC
  `).all(promptVersion);

  if (pending.length === 0) {
    console.log("No pending messages.");
    return;
  }

  // Apply structural pre-filter inline (free, no batch cost).
  let filtered = 0;
  const requests = [];
  const customIdMap = {};
  const dynamicRules = loadCompiledSilenceRules(db);
  for (const m of pending) {
    const noise = classifyAsStructuralNoise(m) || classifyAgainstDynamicRules(dynamicRules, m);
    if (noise) {
      persistTriage(db, m.slack_channel_id, m.slack_ts, {
        worth_deeper_look: false, severity: 1, primary_criterion: "none",
        criteria_matched: [], reason: `Filtered: ${noise.reason}.`,
      }, { model: "structural-filter", usage: {} }, promptVersion);
      filtered += 1;
      continue;
    }
    const ctx = loadFullContext(db, m);
    const userContent = buildTriageUserContent(ctx);
    // Batch custom_id allows only [a-zA-Z0-9_-]; Slack timestamps contain '.'
    const customId = `${m.slack_channel_id}_${m.slack_ts.replace(".", "-")}`;
    customIdMap[customId] = { slack_channel_id: m.slack_channel_id, slack_ts: m.slack_ts };
    requests.push(buildBatchRequest(customId, systemPrompt, userContent, TRIAGE_MODEL, schema));
  }
  console.log(`Pre-filter: ${filtered} filtered for free. ${requests.length} candidates for Batch API (prompt ${promptVersion}).`);

  if (requests.length === 0) return;

  // Cost cap pre-flight.
  const estimate = estimateBudget({ items: [
    { model: TRIAGE_MODEL, mode: "batch", kind: "tier_a_slack", count: requests.length },
  ]});
  console.log(formatEstimate(estimate, args.cap));
  if (!args.forceOverCap) {
    try { enforceCap({ capUsd: args.cap, estimate }); }
    catch (err) { console.error(err.message); process.exit(2); }
  }

  const batch = await submitTriageBatch(requests);
  db.prepare(`
    INSERT INTO batch_jobs (
      batch_id, job_type, prompt_version, request_count, status, submitted_at, custom_id_map_json
    ) VALUES (?, 'triage', ?, ?, 'submitted', ?, ?)
  `).run(batch.id, promptVersion, requests.length, nowIso(), JSON.stringify(customIdMap));
  console.log(`Submitted batch ${batch.id} with ${requests.length} requests. Status: ${batch.processing_status}`);
  console.log(`Poll later: npm run triage:batch -- poll`);
}

async function pollMode() {
  const db = openDatabase();
  const pending = db.prepare(`SELECT * FROM batch_jobs WHERE status = 'submitted' AND job_type = 'triage'`).all();
  if (pending.length === 0) {
    console.log("No pending batch jobs.");
    return;
  }
  for (const job of pending) {
    const status = await getBatchStatus(job.batch_id);
    console.log(`Batch ${job.batch_id}: ${status.processing_status}, ` +
      `processing=${status.request_counts?.processing}, succeeded=${status.request_counts?.succeeded}, errored=${status.request_counts?.errored}`);
    if (status.processing_status !== "ended") continue;

    const customIdMap = JSON.parse(job.custom_id_map_json);
    let ok = 0, errors = 0;
    for await (const row of iterateBatchResults(job.batch_id)) {
      const target = customIdMap[row.custom_id];
      if (!target) { errors += 1; continue; }
      const result = extractTriageResultFromBatchRow(row);
      if (result.error) {
        console.error(`  Error on ${row.custom_id}: ${result.error}`);
        errors += 1;
        continue;
      }
      persistTriage(db, target.slack_channel_id, target.slack_ts, result.parsed, {
        model: result.model, usage: result.usage,
      }, job.prompt_version);
      ok += 1;
    }
    db.prepare(`UPDATE batch_jobs SET status = 'persisted', ended_at = ?, persisted_at = ? WHERE id = ?`)
      .run(nowIso(), nowIso(), job.id);
    console.log(`  Persisted ${ok} results, ${errors} errors. Batch ${job.batch_id} marked persisted.`);
  }
}

async function listMode() {
  const db = openDatabase();
  const rows = db.prepare(`SELECT * FROM batch_jobs ORDER BY id DESC LIMIT 20`).all();
  for (const r of rows) console.log(`#${r.id} batch=${r.batch_id} type=${r.job_type} status=${r.status} count=${r.request_count} submitted=${r.submitted_at}`);
}

async function main() {
  const args = parseArgs(process.argv);
  switch (args.mode) {
    case "submit": await submitMode(args); break;
    case "poll":   await pollMode(); break;
    case "list":   await listMode(); break;
    default:
      console.error(`Unknown mode: ${args.mode}. Use 'submit', 'poll', or 'list'.`);
      process.exit(1);
  }
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
}
