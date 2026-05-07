// Drives Tier A triage over messages that don't yet have a triage_run for the
// current prompt version.
//
// Modes:
//   default                — calls Haiku for each pending message (needs ANTHROPIC_API_KEY)
//   --from-file <path>     — reads pre-computed results from JSON and persists them
//                            (lets us prototype without an API key — see below)
//   --limit N              — cap how many messages to process this run
//   --dry-run              — print contexts that *would* be sent to Haiku, persist nothing
//
// --from-file JSON shape: { results: [ { slack_channel_id, slack_ts, parsed: {worth_deeper_look,...} }, ... ] }

import process from "node:process";
import { readFileSync } from "node:fs";
import { openDatabase, nowIso } from "./lib/db.mjs";
import {
  triageMessage,
  buildTriageUserContent,
  TRIAGE_MODEL,
  getTriagePromptVersion,
  TriageResultSchema,
} from "./lib/triage.mjs";
import { buildRetrievalBundle, renderRetrievalBundle } from "./lib/triage-retrieval.mjs";
import {
  classifyAsStructuralNoise,
  loadCompiledSilenceRules,
  classifyAgainstDynamicRules,
} from "./lib/structural-filter.mjs";
import { getExecFeedbackContextText } from "./lib/exec-feedback-context.mjs";

function parseArgs(argv) {
  const args = { mode: "haiku", limit: null, fromFile: null, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--from-file") { args.mode = "from-file"; args.fromFile = argv[++i]; }
    else if (a === "--limit") { args.limit = Number(argv[++i]); }
    else if (a === "--dry-run") { args.dryRun = true; }
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node scripts/triage-pending.mjs [--from-file path.json] [--limit N] [--dry-run]");
      process.exit(0);
    }
    else { console.error(`Unknown arg: ${a}`); process.exit(1); }
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
  const d = Math.floor(hr / 24);
  return `${d}d`;
}

function loadContext(db, message) {
  const channel = db.prepare(`SELECT * FROM channels WHERE slack_channel_id = ?`).get(message.slack_channel_id);

  const author = message.author_slack_user_id
    ? db.prepare(`SELECT * FROM v_employees_with_slack WHERE slack_user_id = ?`).get(message.author_slack_user_id)
    : null;

  let mentions = [];
  if (message.mentions_user_ids_json) {
    const ids = JSON.parse(message.mentions_user_ids_json);
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      mentions = db.prepare(`SELECT slack_user_id, full_name, is_corporate, employee_title FROM v_employees_with_slack WHERE slack_user_id IN (${placeholders})`).all(...ids);
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

  // Cross-message retrieval bundle (same author + phrase matches).
  const retrieval = buildRetrievalBundle(db, message);
  const retrieval_text = renderRetrievalBundle(retrieval);

  // Exec feedback block — placed after retrieval so the cached prefix stays stable.
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

function persistResult(db, message, parsed, meta, promptVersion) {
  db.prepare(INSERT_TRIAGE_SQL).run({
    slack_channel_id: message.slack_channel_id,
    slack_ts: message.slack_ts,
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

  const pending = db.prepare(`
    SELECT m.*
    FROM messages m
    LEFT JOIN triage_runs t
      ON t.slack_channel_id = m.slack_channel_id
     AND t.slack_ts = m.slack_ts
     AND t.prompt_version = ?
    WHERE t.id IS NULL
    ORDER BY m.message_posted_at DESC
    ${args.limit ? `LIMIT ${Number(args.limit)}` : ""}
  `).all(promptVersion);

  console.log(`Pending: ${pending.length} messages without a ${promptVersion} run.`);

  if (args.mode === "from-file") {
    const payload = JSON.parse(readFileSync(args.fromFile, "utf8"));
    const results = payload.results ?? [];
    const byKey = new Map();
    for (const r of results) byKey.set(`${r.slack_channel_id}:${r.slack_ts}`, r);

    let persisted = 0;
    const txn = db.transaction(() => {
      for (const m of pending) {
        const key = `${m.slack_channel_id}:${m.slack_ts}`;
        const r = byKey.get(key);
        if (!r) continue;
        const parsed = TriageResultSchema.parse(r.parsed);
        persistResult(db, m, parsed, {
          model: r.model ?? "manual-prototype",
          usage: r.usage,
          duration_ms: r.duration_ms ?? null,
        }, promptVersion);
        persisted += 1;
      }
    });
    txn();
    console.log(`Persisted ${persisted} triage results from file.`);
    return;
  }

  if (args.dryRun) {
    for (const m of pending.slice(0, args.limit ?? 3)) {
      const ctx = loadContext(db, m);
      console.log("---");
      console.log(`channel=${m.slack_channel_id} ts=${m.slack_ts}`);
      console.log(buildTriageUserContent(ctx));
    }
    return;
  }

  // Live Haiku mode.
  let ok = 0, errors = 0, filtered = 0;
  const dynamicRules = loadCompiledSilenceRules(db);
  for (const m of pending) {
    // Structural pre-filter: skip clear noise (channel-join, empty bodies,
    // bot integration confirmations, bare @mentions, etc.) without paying
    // for an LLM call. We persist a free triage_run row so the message
    // doesn't keep showing up as pending.
    const noise = classifyAsStructuralNoise(m) || classifyAgainstDynamicRules(dynamicRules, m);
    if (noise) {
      const synthetic = {
        worth_deeper_look: false,
        severity: 1,
        primary_criterion: "none",
        criteria_matched: [],
        reason: `Filtered: ${noise.reason}.`,
      };
      persistResult(db, m, synthetic, { model: "structural-filter", usage: {}, duration_ms: 0 }, promptVersion);
      filtered += 1;
      continue;
    }

    const ctx = loadContext(db, m);
    try {
      const { parsed, usage, duration_ms, model } = await triageMessage(db, ctx);
      persistResult(db, m, parsed, { model, usage, duration_ms }, promptVersion);
      ok += 1;
      console.log(`[${ok}/${pending.length - filtered}] ${m.slack_channel_id}/${m.slack_ts} → ${parsed.worth_deeper_look ? "FLAG" : "ok"} sev=${parsed.severity} (${parsed.primary_criterion})`);
    } catch (err) {
      errors += 1;
      console.error(`Error on ${m.slack_channel_id}/${m.slack_ts}:`, err.message);
    }
  }
  console.log(`\nDone. ${ok} ok via Haiku, ${filtered} filtered structurally (free), ${errors} errors.`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
