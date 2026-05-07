// Look-forward retrigger.
//
// Tier A's cross-message retrieval can only see backward, so the FIRST
// message of a pattern (e.g., the 1st of 3 Liz Hughson manual-relays) gets
// missed. This script fixes that by re-triaging un-flagged messages from
// the same author whenever a NEW flag is added with a systemic criterion.
//
// Idempotent: only re-triages messages that don't already have a v4
// triage_run with worth_deeper_look=1 — once a message has been re-flagged,
// the retrigger is done with it.
//
// Cost: tiny. Each retrigger is a single Haiku call against a fully-cached
// system prompt + the same per-message context the original triage used,
// just with one more entry in the cross-message retrieval bundle.
//
// Usage:
//   npm run lookforward                       # default: scan flags from last 7 days
//   npm run lookforward -- --since 2026-04-20 # explicit window
//   npm run lookforward -- --dry-run          # show what would re-trigger
//
// This is the right tool for first-of-pattern detection until we have
// embeddings + nightly clustering.

import process from "node:process";
import { openDatabase, nowIso } from "./lib/db.mjs";
import {
  triageMessage,
  getTriagePromptVersion,
} from "./lib/triage.mjs";
import { buildRetrievalBundle, renderRetrievalBundle } from "./lib/triage-retrieval.mjs";
import { getExecFeedbackContextText } from "./lib/exec-feedback-context.mjs";

const DEFAULT_LOOKBACK_DAYS_FOR_TRIGGER_SCAN = 7;
const RETRIGGER_AUTHOR_HISTORY_DAYS = 30;
const SYSTEMIC_CRITERIA = new Set([
  "systemic_branch_pattern",
  "sales_relaying_customer_pain",
  "help_channel_dead_air",
]);

function parseArgs(argv) {
  const args = { since: null, dryRun: false, limit: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--since") args.since = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node scripts/lookforward-retrigger.mjs [--since ISO] [--dry-run] [--limit N]");
      process.exit(0);
    }
  }
  return args;
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function elapsedHuman(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "in the future";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  const d = Math.floor(hr / 24);
  return `${d}d`;
}

// Find recent flagged triage runs whose criteria suggest a pattern. For each,
// gather other un-flagged messages from the same author in the same channel
// over the last N days. Those are candidates to re-triage.
function findRetriggerCandidates(db, sinceIso, promptVersion) {
  const flagged = db.prepare(`
    SELECT t.id AS triage_run_id, t.slack_channel_id, t.slack_ts,
           t.primary_criterion, t.criteria_matched_json,
           m.author_slack_user_id, m.message_posted_at
    FROM triage_runs t
    JOIN messages m ON m.slack_channel_id = t.slack_channel_id AND m.slack_ts = t.slack_ts
    WHERE t.prompt_version = ?
      AND t.worth_deeper_look = 1
      AND t.ran_at >= ?
  `).all(promptVersion, sinceIso);

  const candidatesByMessage = new Map(); // key: channel:ts → { reason, source_flag_id }
  for (const f of flagged) {
    const criteria = new Set();
    if (f.primary_criterion) criteria.add(f.primary_criterion);
    try {
      for (const c of JSON.parse(f.criteria_matched_json ?? "[]")) criteria.add(c);
    } catch { /* noop */ }
    const isSystemic = [...criteria].some(c => SYSTEMIC_CRITERIA.has(c));
    if (!isSystemic) continue;
    if (!f.author_slack_user_id) continue;

    const lookback = new Date(new Date(f.message_posted_at).getTime() - RETRIGGER_AUTHOR_HISTORY_DAYS * 86400000).toISOString();
    const candidates = db.prepare(`
      SELECT m.slack_channel_id, m.slack_ts, m.message_posted_at
      FROM messages m
      LEFT JOIN triage_runs t
        ON t.slack_channel_id = m.slack_channel_id
       AND t.slack_ts = m.slack_ts
       AND t.prompt_version = ?
       AND t.worth_deeper_look = 1
      WHERE m.author_slack_user_id = ?
        AND m.slack_channel_id = ?
        AND m.slack_ts != ?
        AND m.message_posted_at >= ?
        AND m.message_posted_at <= ?
        AND t.id IS NULL
    `).all(
      promptVersion,
      f.author_slack_user_id,
      f.slack_channel_id,
      f.slack_ts,
      lookback,
      f.message_posted_at,
    );
    for (const c of candidates) {
      const key = `${c.slack_channel_id}:${c.slack_ts}`;
      if (!candidatesByMessage.has(key)) {
        candidatesByMessage.set(key, {
          slack_channel_id: c.slack_channel_id,
          slack_ts: c.slack_ts,
          message_posted_at: c.message_posted_at,
          source_flag_id: f.triage_run_id,
          reason: `Author had a later flag (criterion=${f.primary_criterion}) at ${f.message_posted_at}`,
        });
      }
    }
  }
  return [...candidatesByMessage.values()];
}

function loadContextForRetrigger(db, candidate) {
  const message = db.prepare(`SELECT * FROM messages WHERE slack_channel_id = ? AND slack_ts = ?`).get(candidate.slack_channel_id, candidate.slack_ts);
  if (!message) return null;
  const channel = db.prepare(`SELECT * FROM channels WHERE slack_channel_id = ?`).get(candidate.slack_channel_id);
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
    WHERE m.slack_channel_id = ?
      AND m.message_posted_at < ?
    ORDER BY m.message_posted_at DESC
    LIMIT 6
  `).all(message.slack_channel_id, message.message_posted_at ?? new Date().toISOString());

  const retrieval = buildRetrievalBundle(db, message);
  const retrieval_text = renderRetrievalBundle(retrieval);
  const exec_feedback_text = getExecFeedbackContextText(db);

  return {
    channel: channel ?? { name: message.slack_channel_id, channel_type: "?" },
    author: author ?? (message.author_slack_user_id ? { slack_user_id: message.author_slack_user_id, author_username: message.author_username } : null),
    mentions,
    recent,
    retrieval_text,
    exec_feedback_text,
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
  @input_tokens, @output_tokens, @cache_read_input_tokens, @cache_creation_input_tokens,
  @ran_at, @duration_ms
)
`;

function persistRetriggered(db, candidate, parsed, meta, promptVersion) {
  db.prepare(INSERT_TRIAGE_SQL).run({
    slack_channel_id: candidate.slack_channel_id,
    slack_ts: candidate.slack_ts,
    model: meta.model,
    prompt_version: promptVersion,
    worth_deeper_look: parsed.worth_deeper_look ? 1 : 0,
    severity: parsed.severity,
    primary_criterion: parsed.primary_criterion,
    criteria_matched_json: JSON.stringify(parsed.criteria_matched ?? []),
    reason: `[lookforward] ${parsed.reason}`,
    full_response_json: JSON.stringify({ ...parsed, retriggered_from_flag: candidate.source_flag_id }),
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
  const promptVersion = getTriagePromptVersion(db);
  const sinceIso = args.since ?? isoDaysAgo(DEFAULT_LOOKBACK_DAYS_FOR_TRIGGER_SCAN);
  console.log(`Scanning systemic flags since ${sinceIso} (prompt ${promptVersion})...`);
  let candidates = findRetriggerCandidates(db, sinceIso, promptVersion);
  if (args.limit) candidates = candidates.slice(0, args.limit);
  console.log(`Found ${candidates.length} look-forward candidate(s) — un-flagged messages from same author near a systemic flag.`);
  if (args.dryRun) {
    for (const c of candidates) console.log(`  - ${c.slack_channel_id}/${c.slack_ts} (${c.message_posted_at}) — ${c.reason}`);
    return;
  }
  let upgraded = 0, unchanged = 0, errors = 0;
  for (const c of candidates) {
    const ctx = loadContextForRetrigger(db, c);
    if (!ctx) continue;
    try {
      const { parsed, usage, duration_ms, model } = await triageMessage(db, ctx);
      persistRetriggered(db, c, parsed, { model, usage, duration_ms }, promptVersion);
      if (parsed.worth_deeper_look) {
        upgraded += 1;
        console.log(`  UPGRADED ${c.slack_channel_id}/${c.slack_ts} → sev ${parsed.severity} (${parsed.primary_criterion})`);
      } else {
        unchanged += 1;
      }
    } catch (err) {
      errors += 1;
      console.error(`Error on ${c.slack_channel_id}/${c.slack_ts}:`, err.message);
    }
  }
  console.log(`\nDone. ${upgraded} upgraded to flagged, ${unchanged} unchanged, ${errors} errors.`);
  if (upgraded > 0) {
    console.log("\nRun \`npm run investigate\` to investigate the new flags, then \`npm run rollup\` to refresh the exec inbox.");
  }
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
}
