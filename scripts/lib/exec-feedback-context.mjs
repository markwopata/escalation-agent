// Pulls recent exec feedback and renders it as a small context block for
// injection into Tier A and Tier B prompts. This is how the agent gets
// smarter from feedback.
//
// Strategy:
//   - Pull the most recent N feedback entries (general + escalation-targeted)
//   - Render compactly (≤500 tokens worst-case)
//   - Place AFTER the cached system prompt so we don't invalidate the cache
//     when feedback updates
//
// The feedback text is the load-bearing field. Sentiment + tags help the
// agent weight the input, but the agent should read the text and infer
// what it actually means.

const DEFAULT_LOOKBACK_DAYS = 60;
const MAX_FEEDBACK_ENTRIES = 12;

export function loadRecentExecFeedback(db, { lookbackDays = DEFAULT_LOOKBACK_DAYS, limit = MAX_FEEDBACK_ENTRIES } = {}) {
  const sinceIso = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  return db.prepare(`
    SELECT id, exec_name, target_type, target_id, feedback_text, sentiment,
           tags_json, created_at,
           target_slack_channel_id, target_slack_ts
    FROM exec_feedback
    WHERE created_at >= ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(sinceIso, limit);
}

export function renderExecFeedbackBlock(entries) {
  if (!entries || entries.length === 0) {
    return "Recent exec feedback (last 60 days): none on file yet — operate on the criteria as written.";
  }
  const lines = [];
  lines.push(`Recent exec feedback (last 60 days, most recent first — ${entries.length} entries):`);
  lines.push("These are the explicit signals the executives have given about what they want more or less of. Weigh them above the static criteria when in conflict — they are calibration ground truth.");
  for (const e of entries) {
    let target;
    if (e.target_type === "escalation" && e.target_id) target = `on escalation #${e.target_id}`;
    else if (e.target_type === "criterion_proposal" && e.target_id) target = `on criterion proposal #${e.target_id}`;
    else if (e.target_type === "message_exemplar" && e.target_slack_ts) target = `EXEMPLAR pointing at message ${e.target_slack_channel_id}/${e.target_slack_ts}`;
    else target = "(general)";
    const sent = e.sentiment ? `[${e.sentiment}]` : "";
    const who = e.exec_name ? `${e.exec_name}` : "exec";
    lines.push(`  - ${e.created_at.slice(0,10)} ${who} ${target} ${sent}: ${e.feedback_text}`);
  }
  lines.push("");
  lines.push("EXEMPLAR feedback above is the strongest signal: the exec hand-picked a specific Slack message and said 'this is what I want flagged' (or didn't want flagged). Treat it as labeled training data — propose a criterion or calibration shift that would have caught (or skipped) that exact message.");
  return lines.join("\n");
}

// Convenience helper for callers that want both in one call.
export function getExecFeedbackContextText(db, opts) {
  const entries = loadRecentExecFeedback(db, opts);
  return renderExecFeedbackBlock(entries);
}
