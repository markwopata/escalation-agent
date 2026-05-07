// Generates the morning exec digest from the escalations table.
//
// Output is markdown by default — pipeable to email, Slack DM (formatted as
// Slack-flavored markdown), or printed to terminal. Each escalation block
// includes a stable `feedback_id` so the exec can reply with feedback that
// references the specific item:
//
//   echo "useful, we already knew about this" | npm run feedback -- \
//     --exec mark --target-type escalation --target-id 7 --sentiment useful
//
// Usage:
//   npm run digest                        # all pending escalations, markdown
//   npm run digest -- --since 2026-04-25  # only escalations updated since
//   npm run digest -- --format json       # machine-readable
//   npm run digest -- --max-severity 4    # cap severity threshold
//
// This is the read-side of the exec feedback loop — what the exec sees
// before they decide what to send back.

import process from "node:process";
import { openDatabase, nowIso } from "./lib/db.mjs";

function parseArgs(argv) {
  const args = { since: null, format: "markdown", minSeverity: 3, includeMonitor: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--since") args.since = argv[++i];
    else if (a === "--format") args.format = argv[++i];
    else if (a === "--min-severity") args.minSeverity = Number(argv[++i]);
    else if (a === "--include-monitor") args.includeMonitor = true;
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node scripts/exec-digest.mjs [--since ISO] [--format markdown|json] [--min-severity N] [--include-monitor]");
      process.exit(0);
    }
  }
  return args;
}

function loadEscalations(db, args) {
  const sinceClause = args.since ? "AND e.last_evidence_at >= @since" : "";
  return db.prepare(`
    SELECT e.id, e.cluster_type, e.primary_criterion, e.criteria_observed_json,
           e.max_severity, e.evidence_message_count,
           e.representative_exec_summary, e.representative_recommended_actions_json,
           e.first_evidence_at, e.last_evidence_at, e.exec_action,
           e.author_slack_user_id, e.slack_channel_id,
           v.full_name AS author_full_name, v.is_corporate,
           v.employee_title AS author_title, v.department_or_function AS author_department,
           c.name AS channel_name
    FROM escalations e
    LEFT JOIN v_employees_with_slack v ON v.slack_user_id = e.author_slack_user_id
    LEFT JOIN channels c ON c.slack_channel_id = e.slack_channel_id
    WHERE e.exec_action = 'pending'
      AND e.max_severity >= @min_severity
      ${sinceClause}
    ORDER BY e.max_severity DESC, e.last_evidence_at DESC
  `).all({ min_severity: args.minSeverity, since: args.since });
}

function severityIcon(sev) {
  if (sev >= 5) return "🚨";
  if (sev === 4) return "🔴";
  if (sev === 3) return "🟠";
  return "🟡";
}

function renderMarkdown(escalations) {
  const lines = [];
  const today = nowIso().slice(0, 10);
  lines.push(`# EquipmentShare Escalation Digest — ${today}`);
  lines.push("");
  if (escalations.length === 0) {
    lines.push("No pending escalations meeting the threshold.");
    return lines.join("\n");
  }
  lines.push(`${escalations.length} pending escalation${escalations.length > 1 ? "s" : ""} for your review.`);
  lines.push("");
  lines.push("Each item has an **escalation ID** (e.g. `#7`). To leave feedback on a specific item:");
  lines.push("```");
  lines.push("echo \"<your text>\" | npm run feedback -- --exec <name> \\");
  lines.push("  --target-type escalation --target-id <id> --sentiment <useful|not_useful|wrong_severity|noise|praise>");
  lines.push("```");
  lines.push("Or for general direction (\"I want more X, less Y\"):");
  lines.push("```");
  lines.push("echo \"<your text>\" | npm run feedback -- --exec <name> --target-type general");
  lines.push("```");
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const e of escalations) {
    const subject = e.author_full_name
      ? `${e.author_full_name} (${e.is_corporate ? "Corp" : "Field"}, ${e.author_title ?? "—"}${e.author_department ? ", " + e.author_department : ""})`
      : (e.channel_name ? `Channel-wide pattern in #${e.channel_name}` : "Unknown subject");
    const criteria = JSON.parse(e.criteria_observed_json ?? "[]");
    lines.push(`## ${severityIcon(e.max_severity)} #${e.id} \u2014 sev ${e.max_severity} \u2014 ${e.primary_criterion}`);
    lines.push(`**Subject:** ${subject}`);
    if (e.channel_name && e.author_full_name) lines.push(`**Channel:** #${e.channel_name}`);
    lines.push(`**Evidence:** ${e.evidence_message_count} message${e.evidence_message_count > 1 ? "s" : ""} \u2014 ${e.first_evidence_at?.slice(0,10)} → ${e.last_evidence_at?.slice(0,10)}`);
    if (criteria.length > 1) lines.push(`**Criteria observed:** ${criteria.join(", ")}`);
    lines.push("");
    lines.push("**Summary:**");
    lines.push("> " + (e.representative_exec_summary ?? "").split("\n").join("\n> "));
    lines.push("");
    const actions = JSON.parse(e.representative_recommended_actions_json ?? "[]");
    if (actions.length) {
      lines.push("**Recommended actions:**");
      actions.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv);
  const db = openDatabase();
  const escalations = loadEscalations(db, args);

  if (args.format === "json") {
    console.log(JSON.stringify(escalations.map(e => ({
      ...e,
      criteria_observed: JSON.parse(e.criteria_observed_json ?? "[]"),
      recommended_actions: JSON.parse(e.representative_recommended_actions_json ?? "[]"),
    })), null, 2));
  } else {
    console.log(renderMarkdown(escalations));
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
}
