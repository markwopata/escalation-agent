// Detects when a "watched exec" (CEO, President, etc.) authors, mentions,
// or otherwise touches a Slack message. The CEO's actual interventions
// are gold-standard ground truth for what they care about — much richer
// than the static seven criteria, because the CEO's behavior reveals
// what makes them stop scrolling and engage.
//
// Detection types:
//   - 'authored':  the exec wrote the message themselves
//   - 'mentioned': someone @-mentioned the exec in a message
//   - 'reacted':   the exec added a non-trivial emoji reaction (future —
//                  needs reactions data we don't fully ingest yet)
//   - 'joined_channel': the exec joined a channel (also future, needs
//                       Events API)
//
// We seed watched_execs from a config file or direct INSERT. The detector
// reads it dynamically so additions take effect without code changes.
//
// Idempotent: writing the same intervention twice is a no-op (UNIQUE index).

import { nowIso } from "./db.mjs";

// Helpers — extract @-mentioned user IDs from a message.
function extractMentionedSlackUserIds(text) {
  if (!text) return [];
  const ids = new Set();
  const re = /<@(U[A-Z0-9]+)(?:\|[^>]*)?>/g;
  let m;
  while ((m = re.exec(text)) !== null) ids.add(m[1]);
  return [...ids];
}

// Returns the set of currently active watched execs as a Map keyed by
// slack_user_id. Falls through to looking up the slack_user_id from the
// employee_slack_link table if the watched_execs row hasn't been resolved
// yet — so adding a new exec by employee_id alone is enough.
export function loadWatchedExecs(db) {
  const rows = db.prepare(`SELECT * FROM watched_execs WHERE active = 1`).all();
  const bySlackId = new Map();
  for (const row of rows) {
    let slackId = row.slack_user_id;
    if (!slackId) {
      const link = db.prepare(`SELECT slack_user_id FROM employee_slack_link WHERE employee_id = ? AND slack_user_id IS NOT NULL`).get(row.employee_id);
      if (link?.slack_user_id) {
        slackId = link.slack_user_id;
        // Cache it back on the watched_execs row to avoid re-resolving.
        db.prepare(`UPDATE watched_execs SET slack_user_id = ? WHERE employee_id = ?`).run(slackId, row.employee_id);
      }
    }
    if (slackId) bySlackId.set(slackId, row);
  }
  return bySlackId;
}

// Inspects a single message and returns an array of { exec_employee_id,
// intervention_type, ... } describing all interventions found. Empty array
// when there are none.
export function detectInterventions(message, watchedBySlackId) {
  const out = [];
  if (!watchedBySlackId || watchedBySlackId.size === 0) return out;
  const channelId = message.slack_channel_id ?? message.channel ?? null;
  if (!channelId) return out;
  const slackTs = String(message.slack_ts ?? message.ts ?? "");
  const intervention_at = message.message_posted_at ?? null;
  const evidenceText = (message.text ?? "").slice(0, 400);

  // 1. Authored: the exec posted the message.
  const author = message.author_slack_user_id ?? message.user ?? null;
  if (author && watchedBySlackId.has(author)) {
    const w = watchedBySlackId.get(author);
    out.push({
      exec_employee_id: w.employee_id,
      exec_slack_user_id: author,
      exec_display_name: w.display_name,
      intervention_type: "authored",
      slack_channel_id: channelId,
      slack_ts: slackTs,
      thread_ts: message.thread_ts ?? null,
      authored_by_slack_user_id: author,
      evidence_text: evidenceText,
      intervention_at,
    });
  }

  // 2. Mentioned: someone @-mentioned the exec.
  const mentions = message.mentions_user_ids_json
    ? (() => { try { return JSON.parse(message.mentions_user_ids_json); } catch { return []; } })()
    : extractMentionedSlackUserIds(message.text);
  for (const mid of mentions) {
    if (watchedBySlackId.has(mid)) {
      // Skip self-mentions
      if (mid === author) continue;
      const w = watchedBySlackId.get(mid);
      out.push({
        exec_employee_id: w.employee_id,
        exec_slack_user_id: mid,
        exec_display_name: w.display_name,
        intervention_type: "mentioned",
        slack_channel_id: channelId,
        slack_ts: slackTs,
        thread_ts: message.thread_ts ?? null,
        authored_by_slack_user_id: author,
        evidence_text: evidenceText,
        intervention_at,
      });
    }
  }

  return out;
}

const INSERT_INTERVENTION_SQL = `
INSERT OR IGNORE INTO ceo_interventions (
  exec_employee_id, exec_slack_user_id, exec_display_name,
  intervention_type, slack_channel_id, slack_ts, thread_ts,
  authored_by_slack_user_id, evidence_text,
  intervention_at, detected_at
) VALUES (
  @exec_employee_id, @exec_slack_user_id, @exec_display_name,
  @intervention_type, @slack_channel_id, @slack_ts, @thread_ts,
  @authored_by_slack_user_id, @evidence_text,
  @intervention_at, @detected_at
)
`;

export function persistInterventions(db, interventions) {
  if (!interventions || interventions.length === 0) return 0;
  const now = nowIso();
  const stmt = db.prepare(INSERT_INTERVENTION_SQL);
  let count = 0;
  for (const i of interventions) {
    const result = stmt.run({ ...i, detected_at: now });
    if (result.changes > 0) count += 1;
  }
  return count;
}

// Convenience: run detect+persist for a single message in one call.
export function detectAndPersist(db, message, watchedBySlackId) {
  const interventions = detectInterventions(message, watchedBySlackId);
  if (interventions.length === 0) return 0;
  return persistInterventions(db, interventions);
}
