// Re-renders existing digest_deliveries with the latest block format
// (chat.update). Use this after changing block-builder logic to refresh
// previously-sent messages without spamming recipients with duplicates.
//
// Usage:
//   npm run refresh:digest                  # refresh all deliveries
//   npm run refresh:digest -- --recipient mark
//   npm run refresh:digest -- --escalation-id 11

import process from "node:process";
import { openDatabase } from "./lib/db.mjs";
import { updateMessage, postMessage, getPermalink } from "./lib/slack-write.mjs";

function parseArgs(argv) {
  const args = { recipient: null, escalationId: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--recipient") args.recipient = argv[++i];
    else if (a === "--escalation-id") args.escalationId = Number(argv[++i]);
  }
  return args;
}

const SEV_EMOJI = {5: ":rotating_light:", 4: ":red_circle:", 3: ":large_orange_circle:", 2: ":large_yellow_circle:", 1: ":large_blue_circle:"};

// NOTE: this duplicates the block builder in send-digest.mjs. Both write
// the same Block Kit shape; if you change one, change both. Could be
// extracted into a shared lib/digest-blocks.mjs but keeping inline for now
// since the two scripts diverge slightly (refresh works with already-saved
// data, send works with live escalations).

async function resolveSourceMessages(db, escalation, max = 3) {
  let ids = [];
  try { ids = JSON.parse(escalation.evidence_investigation_ids_json ?? "[]"); } catch {}
  if (ids.length === 0 && escalation.representative_investigation_id) ids = [escalation.representative_investigation_id];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT m.slack_channel_id, m.slack_ts, m.message_posted_at,
           SUBSTR(m.text, 1, 140) AS text_preview,
           c.name AS channel_name,
           v.full_name AS author_name
    FROM investigations i
    JOIN triage_runs t ON t.id = i.triage_run_id
    JOIN messages m ON m.slack_channel_id = t.slack_channel_id AND m.slack_ts = t.slack_ts
    JOIN channels c ON c.slack_channel_id = m.slack_channel_id
    LEFT JOIN v_employees_with_slack v ON v.slack_user_id = m.author_slack_user_id
    WHERE i.id IN (${placeholders})
    GROUP BY m.slack_channel_id, m.slack_ts
    ORDER BY m.message_posted_at DESC
    LIMIT ?
  `).all(...ids, max);
  const out = [];
  for (const r of rows) {
    try {
      const permalink = await getPermalink({ channel: r.slack_channel_id, message_ts: r.slack_ts });
      out.push({ ...r, permalink });
    } catch (err) {
      console.warn(`  permalink failed for ${r.slack_channel_id}/${r.slack_ts}: ${err.message}`);
    }
  }
  return out;
}

function buildHeadlineBlocks(esc, sources) {
  const sev = esc.max_severity;
  // Source indicator only — Slack vs Front.
  const emoji = esc.source === "front" ? ":incoming_envelope:" : ":slack:";
  const title = esc.display_title ?? `Escalation #${esc.id}`;
  const shortSummary = esc.display_title_short_summary ?? esc.representative_exec_summary?.slice(0, 220);
  const primarySource = sources?.[0];
  const linkLabel = primarySource?.permalink?.includes("frontapp.com") ? "Front Link" : "Slack Link";
  let origin = "";
  if (esc.source === "front" && esc.front_inbox_name) origin = `  ·  _inbox: ${esc.front_inbox_name}_`;
  else if (esc.channel_name) origin = `  ·  _#${esc.channel_name}_`;
  const headline = primarySource
    ? `${emoji} *${title}*${origin}  ·  <${primarySource.permalink}|${linkLabel}>`
    : `${emoji} *${title}*${origin}`;
  return [{ type: "section", text: { type: "mrkdwn", text: `${headline}\n${shortSummary}` } }];
}

function buildDetailBlocks(esc, sources) {
  const sev = esc.max_severity;
  const criteria = (() => { try { return JSON.parse(esc.criteria_observed_json ?? "[]"); } catch { return []; } })();
  const actions = (() => { try { return JSON.parse(esc.representative_recommended_actions_json ?? "[]"); } catch { return []; } })();
  const subject = esc.author_full_name
    ? `${esc.author_full_name} (${esc.is_corporate ? "Corp" : "Field"}, ${esc.author_title ?? "—"}${esc.author_department ? " · " + esc.author_department : ""})`
    : (esc.channel_name ? `Channel-wide pattern in #${esc.channel_name}` : "Unknown subject");
  const blocks = [];
  const metaParts = [
    `sev ${sev}`, esc.primary_criterion,
    `${esc.evidence_message_count} msg${esc.evidence_message_count > 1 ? "s" : ""}`,
    `${esc.first_evidence_at?.slice(0,10)} → ${esc.last_evidence_at?.slice(0,10)}`,
    subject,
  ];
  if (criteria.length > 1) metaParts.push(`also: ${criteria.filter(c => c !== esc.primary_criterion).join(", ")}`);
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `_${metaParts.join("  ·  ")}_` }] });
  if (actions.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Recommended actions:*\n${actions.slice(0, 5).map((a, i) => `${i + 1}. ${a}`).join("\n")}` } });
  }
  if (sources && sources.length > 1) {
    const lines = sources.slice(1).map((s) => {
      const who = s.author_name ?? "unknown";
      const when = s.message_posted_at?.slice(0, 10) ?? "?";
      const preview = (s.text_preview ?? "").replace(/\n/g, " ").trim().slice(0, 80);
      return `• <${s.permalink}|${when} · ${who}>: ${preview}${preview.length >= 80 ? "…" : ""}`;
    }).join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Other source messages (${sources.length - 1}):*\n${lines}` } });
  }
  const longSummary = esc.representative_exec_summary;
  if (longSummary && longSummary.length > 220) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Full detail:*\n> ${longSummary.split("\n").join("\n> ")}` } });
  }
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: ":speech_balloon: React :+1: / :-1: / :no_entry: / :rotating_light: on the parent message · or reply here for free-text feedback" }] });
  return blocks;
}

async function main() {
  const args = parseArgs(process.argv);
  const db = openDatabase();
  let deliveries = db.prepare(`
    SELECT d.*, e.id AS escalation_id, e.max_severity, e.cluster_type, e.primary_criterion,
           e.criteria_observed_json, e.evidence_message_count,
           e.representative_exec_summary, e.representative_recommended_actions_json,
           e.evidence_investigation_ids_json, e.representative_investigation_id,
           e.display_title, e.display_title_short_summary, e.display_emoji,
           e.first_evidence_at, e.last_evidence_at,
           e.author_slack_user_id, e.slack_channel_id AS esc_channel_id,
           e.source, e.front_conversation_id, e.front_inbox_id, e.front_investigation_id,
           v.full_name AS author_full_name, v.is_corporate,
           v.employee_title AS author_title, v.department_or_function AS author_department,
           c.name AS channel_name,
           fc.subject AS front_subject, fc.inbox_name AS front_inbox_name
    FROM digest_deliveries d
    JOIN escalations e ON e.id = d.escalation_id
    LEFT JOIN v_employees_with_slack v ON v.slack_user_id = e.author_slack_user_id
    LEFT JOIN channels c ON c.slack_channel_id = e.slack_channel_id
    LEFT JOIN front_conversations fc ON fc.conversation_id = e.front_conversation_id
    ORDER BY d.delivered_at DESC
  `).all();
  if (args.recipient) deliveries = deliveries.filter(d => d.recipient_slack_user_id.includes(args.recipient.toUpperCase()));
  if (args.escalationId) deliveries = deliveries.filter(d => d.escalation_id === args.escalationId);
  console.log(`Refreshing ${deliveries.length} delivery(ies)...`);
  let ok = 0, errors = 0;
  for (const d of deliveries) {
    try {
      const sources = await resolveSourceMessages(db, d, 3);
      const headlineBlocks = buildHeadlineBlocks(d, sources);
      const text = `[sev ${d.max_severity}] ${d.display_title ?? "#" + d.escalation_id}`;
      await updateMessage({ channel: d.bot_message_channel, ts: d.bot_message_ts, text, blocks: headlineBlocks });
      // Post (or re-post) the detail as a thread reply on this message.
      // Note: we don't track existing thread replies, so a refresh will add
      // another. Acceptable trade-off; manual cleanup if it gets noisy.
      const detailBlocks = buildDetailBlocks(d, sources);
      try {
        await postMessage({
          channel: d.bot_message_channel,
          text: `Detail for: ${d.display_title ?? "escalation #" + d.escalation_id}`,
          blocks: detailBlocks,
          threadTs: d.bot_message_ts,
        });
      } catch (err) {
        console.warn(`  detail thread reply failed for #${d.escalation_id}: ${err.message}`);
      }
      console.log(`✓ refreshed escalation #${d.escalation_id} → ${d.recipient_slack_user_id}`);
      ok += 1;
    } catch (err) {
      console.error(`✗ #${d.escalation_id}: ${err.message}`);
      errors += 1;
    }
  }
  console.log(`\nDone. ${ok} refreshed, ${errors} errors.`);
}

try { await main(); } catch (e) { console.error(e instanceof Error ? e.stack : String(e)); process.exit(1); }
