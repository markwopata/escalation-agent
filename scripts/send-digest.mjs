// Sends the escalation digest as Slack DMs to every watched_exec.
//
// One Slack message per escalation, formatted with Block Kit. Each message
// records its bot_message_ts in digest_deliveries so the feedback listener
// can map reactions/replies back to the escalation.
//
// Idempotent: never re-delivers an escalation already sent to the same exec
// (UNIQUE index on (recipient_slack_user_id, escalation_id)).
//
// Token priority for writes (see slack-write.mjs): SLACK_BOT_TOKEN_BOT
// (xoxb-) preferred; falls back to SLACK_BOT_TOKEN (xoxp-, user token) if
// the bot token isn't set yet — useful while waiting on admin approval.
//
// Usage:
//   npm run send:digest                         # all pending escalations to all watched execs
//   npm run send:digest -- --min-severity 4     # only sev 4+
//   npm run send:digest -- --dry-run            # log what we'd send, post nothing
//   npm run send:digest -- --recipient mark.wopata  # filter by exec display_name

import process from "node:process";
import { openDatabase, nowIso } from "./lib/db.mjs";
import { openIm, postMessage, updateMessage, getPermalink, getWriteTokenKind } from "./lib/slack-write.mjs";
import { rankAndCap, rankAndBalance, scoreEscalation } from "./lib/escalation-score.mjs";
import { buildRouter, buildRouterFromCache } from "./lib/slack-token-router.mjs";
import { revalidateSlackEscalation, recordRevalidation } from "./lib/digest-revalidate.mjs";

function parseArgs(argv) {
  // Default: avg 3-5/day, cap 6/day, 72h recency window.
  // 72h chosen from scenario sweep: 24h gives 1.8/day, 48h gives 2.9/day,
  // 72h gives 3.6/day — closest to target with current escalation volume.
  const args = { minSeverity: 3, dryRun: false, recipient: null, limit: null, max: 6, sinceHours: 72, ignoreDeliveries: false, noRevalidate: false, sourceMin: 1, sevFloor: 2 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--min-severity") args.minSeverity = Number(argv[++i]);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--recipient") args.recipient = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--max") args.max = Number(argv[++i]);
    else if (a === "--since-hours") args.sinceHours = Number(argv[++i]);
    else if (a === "--ignore-deliveries") args.ignoreDeliveries = true;
    else if (a === "--no-revalidate") args.noRevalidate = true;
    else if (a === "--source-min") args.sourceMin = Number(argv[++i]);
    else if (a === "--sev-floor") args.sevFloor = Number(argv[++i]);
  }
  return args;
}

const SEV_EMOJI = {
  5: ":rotating_light:",
  4: ":red_circle:",
  3: ":large_orange_circle:",
  2: ":large_yellow_circle:",
  1: ":large_blue_circle:",
};

// Supplemental loader: pulls the top-N pending items for a SINGLE source with
// a much wider lookback. Used to backfill the source-min floor when the
// primary recency window doesn't have enough viable candidates of one source.
//
// Mark's directive: digest must contain >=2 from each source when total>3.
// On a Slack-quiet day (most Slack flagged items are dead-air-style and
// drop at revalidation), the primary 24-72h pool can be exhausted; we then
// reach back further to keep cross-surface visibility.
function loadSupplementalFromSource(db, recipientSlackUserId, minSeverity, source, lookbackHours, excludeIds, ignoreDeliveries) {
  const hasAccessRows = db.prepare(`
    SELECT 1 FROM channel_token_access WHERE token_owner_slack_id = ? LIMIT 1
  `).get(recipientSlackUserId);
  const accessFilter = hasAccessRows
    ? `AND (
         e.source = 'front'
         OR c.channel_type = 'public'
         OR EXISTS (
           SELECT 1 FROM channel_token_access cta
           WHERE cta.slack_channel_id = e.slack_channel_id
             AND cta.token_owner_slack_id = @recipient
             AND cta.is_member = 1
         )
       )`
    : ``;
  // Build named placeholders @ex0, @ex1, ... so we can keep all params named.
  const excludeNames = excludeIds.map((_, i) => `@ex${i}`);
  const excludeBinds = Object.fromEntries(excludeIds.map((id, i) => [`ex${i}`, id]));
  const excludeClause = excludeIds.length > 0
    ? `AND e.id NOT IN (${excludeNames.join(",")})`
    : ``;
  return db.prepare(`
    SELECT e.id, e.cluster_type, e.primary_criterion, e.criteria_observed_json,
           e.max_severity, e.evidence_message_count,
           e.representative_exec_summary, e.representative_recommended_actions_json,
           e.evidence_investigation_ids_json, e.representative_investigation_id,
           e.display_title, e.display_title_short_summary, e.display_emoji,
           e.first_evidence_at, e.last_evidence_at,
           e.author_slack_user_id, e.slack_channel_id,
           e.source, e.front_conversation_id, e.front_inbox_id, e.front_investigation_id,
           v.full_name AS author_full_name,
           v.is_corporate, v.employee_title AS author_title,
           v.department_or_function AS author_department,
           c.name AS channel_name,
           fc.subject AS front_subject, fc.inbox_name AS front_inbox_name
    FROM escalations e
    LEFT JOIN v_employees_with_slack v ON v.slack_user_id = e.author_slack_user_id
    LEFT JOIN channels c ON c.slack_channel_id = e.slack_channel_id
    LEFT JOIN front_conversations fc ON fc.conversation_id = e.front_conversation_id
    LEFT JOIN (
      SELECT escalation_id, MAX(delivered_at) AS last_delivered_at
      FROM digest_deliveries
      WHERE recipient_slack_user_id = @recipient
      GROUP BY escalation_id
    ) d ON d.escalation_id = e.id
    WHERE e.exec_action = 'pending'
      AND e.max_severity >= @min_severity
      AND e.source = @source
      ${ignoreDeliveries ? "" : "AND (d.last_delivered_at IS NULL OR (e.signal_event_at IS NOT NULL AND e.signal_event_at > d.last_delivered_at))"}
      AND e.last_evidence_at >= datetime('now', '-' || @lookback_hours || ' hours')
      ${excludeClause}
      ${accessFilter}
    ORDER BY e.max_severity DESC, e.last_evidence_at DESC
  `).all({ recipient: recipientSlackUserId, min_severity: minSeverity, source, lookback_hours: lookbackHours, ...excludeBinds });
}

function loadPendingEscalationsForRecipient(db, recipientSlackUserId, minSeverity, sinceHours = 24, ignoreDeliveries = false) {
  // Per-recipient access filter: only include escalations whose channel
  // this recipient has membership access to (per channel_token_access).
  //
  // We only apply the filter if this recipient has at least one access row
  // — otherwise we'd silently send zero escalations to anyone whose token
  // hasn't been routed yet (e.g. a new exec onboarding). When unfiltered,
  // the loose default keeps the existing pre-multi-token behavior.
  const hasAccessRows = db.prepare(`
    SELECT 1 FROM channel_token_access WHERE token_owner_slack_id = ? LIMIT 1
  `).get(recipientSlackUserId);
  // Source-aware access:
  //   - Front escalations: broadcast (no inbox-membership tracking yet).
  //   - Slack public channels: broadcast (workspace-readable).
  //   - Slack private channels: filter by channel_token_access.is_member.
  const accessFilter = hasAccessRows
    ? `AND (
         e.source = 'front'
         OR c.channel_type = 'public'
         OR EXISTS (
           SELECT 1 FROM channel_token_access cta
           WHERE cta.slack_channel_id = e.slack_channel_id
             AND cta.token_owner_slack_id = @recipient
             AND cta.is_member = 1
         )
       )`
    : ``;

  return db.prepare(`
    SELECT e.id, e.cluster_type, e.primary_criterion, e.criteria_observed_json,
           e.max_severity, e.evidence_message_count,
           e.representative_exec_summary, e.representative_recommended_actions_json,
           e.evidence_investigation_ids_json, e.representative_investigation_id,
           e.display_title, e.display_title_short_summary, e.display_emoji,
           e.first_evidence_at, e.last_evidence_at,
           e.author_slack_user_id, e.slack_channel_id,
           e.source, e.front_conversation_id, e.front_inbox_id, e.front_investigation_id,
           v.full_name AS author_full_name,
           v.is_corporate, v.employee_title AS author_title,
           v.department_or_function AS author_department,
           c.name AS channel_name,
           fc.subject AS front_subject, fc.inbox_name AS front_inbox_name
    FROM escalations e
    LEFT JOIN v_employees_with_slack v ON v.slack_user_id = e.author_slack_user_id
    LEFT JOIN channels c ON c.slack_channel_id = e.slack_channel_id
    LEFT JOIN front_conversations fc ON fc.conversation_id = e.front_conversation_id
    LEFT JOIN (
      SELECT escalation_id, MAX(delivered_at) AS last_delivered_at
      FROM digest_deliveries
      WHERE recipient_slack_user_id = @recipient
      GROUP BY escalation_id
    ) d ON d.escalation_id = e.id
    WHERE e.exec_action = 'pending'
      AND e.max_severity >= @min_severity
      ${ignoreDeliveries ? "" : "AND (d.last_delivered_at IS NULL OR (e.signal_event_at IS NOT NULL AND e.signal_event_at > d.last_delivered_at))"}
      AND e.last_evidence_at >= datetime('now', '-' || @since_hours || ' hours')
      ${accessFilter}
    ORDER BY e.max_severity DESC, e.last_evidence_at DESC
  `).all({ recipient: recipientSlackUserId, min_severity: minSeverity, since_hours: sinceHours });
}

// Resolve up to N source messages for an escalation. For Slack escalations
// these are message permalinks; for Front escalations these are Front
// conversation URLs. Returns [{permalink, channel_name, author_name, text_preview, posted_at}, ...].
async function resolveSourceMessages(db, escalation, max = 3) {
  // Front-sourced: pull the linked Front conversations.
  if (escalation.source === "front") {
    let investigationIds = [];
    try { investigationIds = JSON.parse(escalation.evidence_investigation_ids_json ?? "[]"); } catch { investigationIds = []; }
    if (investigationIds.length === 0 && escalation.front_investigation_id) {
      investigationIds = [escalation.front_investigation_id];
    }
    if (investigationIds.length === 0) return [];
    const placeholders = investigationIds.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT fc.conversation_id, fc.inbox_id, fc.subject, fc.inbox_name, fc.conversation_created_at,
             fc.recipient_handle,
             (SELECT fm.message_id FROM front_messages fm
              WHERE fm.conversation_id = fc.conversation_id
              ORDER BY fm.turn_index ASC LIMIT 1) AS first_message_id
      FROM front_investigations fi
      JOIN front_conversations fc ON fc.conversation_id = fi.conversation_id
      WHERE fi.id IN (${placeholders})
      GROUP BY fc.conversation_id
      ORDER BY fc.conversation_created_at DESC
      LIMIT ?
    `).all(...investigationIds, max);
    return rows.map(r => ({
      // Inbox-level link only. The conversation-level `/open/{cnv_id}` and
      // message-level `/open/{msg_id}` deep links don't reliably work with
      // the API-side IDs we have — Front's web app uses a separate numeric
      // ID space and routes session-specifically. Until we wire up the
      // Front REST API to fetch canonical web URLs, ship a link that lands
      // the user in the right inbox. They can then locate the conversation
      // by subject or sender. Tracked as a follow-up to upgrade.
      permalink: r.inbox_id
        ? `https://app.frontapp.com/inboxes/folder/${r.inbox_id}`
        : `https://app.frontapp.com/open/${r.conversation_id}`,
      channel_name: r.inbox_name,
      author_name: r.recipient_handle ?? "customer",
      text_preview: r.subject ?? "",
      message_posted_at: r.conversation_created_at,
      slack_channel_id: null,
      slack_ts: null,
    }));
  }

  // Slack-sourced: existing path.
  let investigationIds = [];
  try { investigationIds = JSON.parse(escalation.evidence_investigation_ids_json ?? "[]"); } catch { investigationIds = []; }
  if (investigationIds.length === 0 && escalation.representative_investigation_id) {
    investigationIds = [escalation.representative_investigation_id];
  }
  if (investigationIds.length === 0) return [];

  const placeholders = investigationIds.map(() => "?").join(",");
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
  `).all(...investigationIds, max);

  // Resolve permalinks (cheap — chat.getPermalink is rate-limited tier 4 = 100/min).
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

// Headline message — the only thing the exec sees in their DM list.
// 2-3 lines max: severity emoji + title + 2-sentence summary, with the
// deep link as the call-to-action. Everything else (recommended actions,
// other sources, full detail) goes in a thread reply.
function buildHeadlineBlocks(esc, sources) {
  // Source indicator only — Slack vs Front. Severity emoji and contextual
  // emoji both rejected as visually noisy / redundant; every escalation is a
  // problem. Source is the only thing that distinguishes them visually.
  const emoji = esc.source === "front" ? ":incoming_envelope:" : ":slack:";
  const title = esc.display_title ?? `Escalation #${esc.id}`;
  const shortSummary = esc.display_title_short_summary ?? esc.representative_exec_summary?.slice(0, 220);
  const primarySource = sources?.[0];

  // Label depends on source. Slack-sourced gets the channel name; Front-sourced gets the inbox name.
  const linkLabel = primarySource?.permalink?.includes("frontapp.com") ? "Front Link" : "Slack Link";
  // Surface origin in the headline: #channel for Slack, "inbox: Name" for Front.
  let origin = "";
  if (esc.source === "front" && esc.front_inbox_name) origin = `  ·  _inbox: ${esc.front_inbox_name}_`;
  else if (esc.channel_name) origin = `  ·  _#${esc.channel_name}_`;
  const headline = primarySource
    ? `${emoji} *${title}*${origin}  ·  <${primarySource.permalink}|${linkLabel}>`
    : `${emoji} *${title}*${origin}`;

  return [
    { type: "section", text: { type: "mrkdwn", text: `${headline}\n${shortSummary}` } },
  ];
}

// Detail message posted as a thread reply to the headline. Holds everything
// non-essential: recommended actions, full detail paragraph, additional
// source links, react/reply guidance.
function buildDetailBlocks(esc, sources) {
  const sev = esc.max_severity;
  const criteria = (() => { try { return JSON.parse(esc.criteria_observed_json ?? "[]"); } catch { return []; } })();
  const actions = (() => { try { return JSON.parse(esc.representative_recommended_actions_json ?? "[]"); } catch { return []; } })();
  // Source-aware subject line.
  let subject;
  if (esc.source === "front") {
    subject = esc.front_inbox_name
      ? `Front · "${esc.front_subject ?? "(no subject)"}" · ${esc.front_inbox_name} inbox`
      : "Front conversation";
  } else if (esc.author_full_name) {
    subject = `${esc.author_full_name} (${esc.is_corporate ? "Corp" : "Field"}, ${esc.author_title ?? "—"}${esc.author_department ? " · " + esc.author_department : ""})`;
  } else {
    subject = esc.channel_name ? `Channel-wide pattern in #${esc.channel_name}` : "Unknown subject";
  }

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
    // Top 3 actions, each truncated to ~140 chars so the block stays scannable.
    const topActions = actions.slice(0, 3).map((a, i) => {
      const shortened = a.length > 140 ? a.slice(0, 137) + "…" : a;
      return `${i + 1}. ${shortened}`;
    });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Recommended actions:*\n${topActions.join("\n")}` },
    });
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

  // Digest-time revalidation status (Slack-sourced only). Lets the recipient
  // see at a glance whether the thread has moved since triage.
  if (esc._revalidation?.statusNote) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: esc._revalidation.statusNote }],
    });
  }

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: ":speech_balloon: React :+1: / :-1: / :no_entry: / :rotating_light: on the parent message · or reply here for free-text feedback" }],
  });

  return blocks;
}

// Try to extract a sender name from the message body. Heuristic only —
// looks at the line just before any `Name <email>` or first email in
// signature blocks; falls back to first non-empty line near the bottom.
function extractSenderName(text, knownEmail) {
  if (!text) return null;
  const lines = text.split("\n").map(l => l.trim());
  // Look for "Name <email>" pattern
  const nameEmail = text.match(/([A-Z][A-Za-z .'-]{2,40})\s*<\s*([\w._%+-]+@[\w.-]+)\s*>/);
  if (nameEmail) return nameEmail[1].trim();
  // Look for the line just before the first email occurrence
  if (knownEmail) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(knownEmail)) {
        // Walk back up to 3 lines for a plausible name (Title-Case, no @)
        for (let j = Math.max(0, i - 3); j < i; j++) {
          const l = lines[j];
          if (l && l.length < 60 && !l.includes("@") && /^[A-Z][a-z]/.test(l)) return l;
        }
      }
    }
  }
  return null;
}

// Front-only: fetch the full thread transcript and render as Slack mrkdwn
// blocks for embedding at the end of the detail thread. Some execs don't
// have Front access, so we ship the raw thread inline. Each turn now
// shows From / To headers using conversation-level recipient_handle +
// inbox name, so the exec can see who's emailing whom without opening Front.
function buildFrontTranscriptBlocks(db, conversationId) {
  const conv = db.prepare(`
    SELECT recipient_handle, inbox_name FROM front_conversations WHERE conversation_id = ?
  `).get(conversationId) ?? {};
  const customerEmail = conv.recipient_handle ?? "(unknown customer)";
  const inboxName = conv.inbox_name ?? "(unknown inbox)";

  const turns = db.prepare(`
    SELECT turn_index, role, created_at, text
    FROM front_messages WHERE conversation_id = ?
    ORDER BY turn_index
  `).all(conversationId);
  if (turns.length === 0) return [];

  const blocks = [];
  blocks.push({ type: "divider" });
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*Full Front conversation* (${turns.length} message${turns.length === 1 ? "" : "s"})` },
  });
  // Slack mrkdwn block character cap is 3000. Build chunks if the transcript is long.
  let buf = "";
  const chunks = [];
  for (const t of turns) {
    const when = (t.created_at ?? "").slice(0, 16).replace("T", " ");
    const isCustomer = t.role === "customer";
    const senderName = extractSenderName(t.text, isCustomer ? customerEmail : null);
    const fromLabel = isCustomer
      ? (senderName ? `${senderName} <${customerEmail}>` : customerEmail)
      : (senderName ? `${senderName} (EquipmentShare)` : `EquipmentShare · ${inboxName} inbox`);
    const toLabel = isCustomer
      ? `${inboxName} inbox`
      : customerEmail;
    const text = (t.text ?? "").trim().slice(0, 1500);
    const roleEmoji = isCustomer ? "👤" : "🛠";
    const turnText = `\n${roleEmoji} *${isCustomer ? "CUSTOMER" : "ES_EMPLOYEE"}* · ${when}\n*From:* ${fromLabel}\n*To:* ${toLabel}\n\n${text}\n`;
    if (buf.length + turnText.length > 2800) {
      chunks.push(buf);
      buf = turnText;
    } else {
      buf += turnText;
    }
  }
  if (buf.length) chunks.push(buf);
  for (const chunk of chunks) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
  }
  return blocks;
}

function buildPlaintextFallback(esc) {
  // Used as the `text` field for notifications and for clients without Block Kit.
  const sev = esc.max_severity;
  return `[sev ${sev}] #${esc.id} ${esc.primary_criterion} — ${esc.representative_exec_summary?.slice(0, 220) ?? "(no summary)"}`;
}

async function deliverToExec(db, exec, args, router) {
  const recipient = exec.slack_user_id;
  if (!recipient) {
    console.log(`Skipping ${exec.display_name}: no slack_user_id`);
    return { sent: 0, skipped: 0 };
  }
  let escalations = loadPendingEscalationsForRecipient(db, recipient, args.minSeverity, args.sinceHours, args.ignoreDeliveries);
  const totalCandidates = escalations.length;

  // Digest-time re-validation: re-check parent thread state for Slack-sourced
  // escalations BEFORE ranking/balancing, so drops can't hide low-score-but-
  // still-valid items below the rank+cap horizon. Front-sourced escalations
  // skip Slack revalidation since Front data refreshes hourly via Snowflake —
  // the stored state IS the live state from a digest perspective. Runs in
  // dry-run too so the preview reflects what would actually deliver.
  if (!args.noRevalidate && router) {
    const revalidated = [];
    for (const esc of escalations) {
      const result = await revalidateSlackEscalation(db, esc, router);
      try { recordRevalidation(db, esc.id, result); } catch (err) { console.warn(`  revalidation log failed for #${esc.id}: ${err.message}`); }
      if (result.shouldDrop) {
        console.log(`  ⊘ #${esc.id} dropped at digest time: ${result.dropReason}`);
        continue;
      }
      revalidated.push({ ...esc, _revalidation: result });
    }
    escalations = revalidated;
  }

  // Sev-5 always-visible backfill: regardless of recency window, the digest
  // should surface sev-5 items if they exist and survive revalidation. Sev-5
  // is rare and exec-relevant by definition; aging-out of the 72h fresh
  // window is the wrong default. We pull up to args.sevFloor sev-5 items
  // from the last 30 days, revalidate them, and add survivors that aren't
  // already in the pool.
  if (args.sevFloor > 0) {
    const SEV_FLOOR_LOOKBACK_HOURS = 24 * 30;
    const haveSev5 = escalations.filter(e => e.max_severity >= 5).length;
    if (haveSev5 < args.sevFloor) {
      const need = args.sevFloor - haveSev5;
      const excludeIds = escalations.map(e => e.id);
      // Pull sev-5 candidates from BOTH sources via two queries (loadSupplemental
      // is per-source; we want all-source for the sev-floor).
      const slack = loadSupplementalFromSource(db, recipient, 5, "slack", SEV_FLOOR_LOOKBACK_HOURS, excludeIds, args.ignoreDeliveries);
      const front = loadSupplementalFromSource(db, recipient, 5, "front", SEV_FLOOR_LOOKBACK_HOURS, excludeIds, args.ignoreDeliveries);
      const candidates = [...slack, ...front].sort((a, b) =>
        new Date(b.last_evidence_at ?? 0) - new Date(a.last_evidence_at ?? 0)
      );
      if (candidates.length > 0) {
        console.log(`  ↑ sev-5 backfill: have ${haveSev5}, need ${need} more, considering ${candidates.length} from last 30d`);
        let added = 0;
        for (const cand of candidates) {
          if (added >= need) break;
          if (cand.source === "front") {
            escalations.push({ ...cand, _revalidation: { statusNote: "_supplemental: sev-5 pulled from extended 30d window_" } });
            added += 1;
            console.log(`  ↑ added sev-5 Front #${cand.id} ${cand.last_evidence_at?.slice(0,10)}`);
            continue;
          }
          if (router && !args.noRevalidate) {
            const result = await revalidateSlackEscalation(db, cand, router);
            try { recordRevalidation(db, cand.id, result); } catch {}
            if (result.shouldDrop) {
              console.log(`  ⊘ sev-5 supplemental #${cand.id} dropped: ${result.dropReason}`);
              continue;
            }
            escalations.push({ ...cand, _revalidation: result });
          } else {
            escalations.push({ ...cand, _revalidation: null });
          }
          added += 1;
          console.log(`  ↑ added sev-5 Slack #${cand.id} ${cand.last_evidence_at?.slice(0,10)}`);
        }
      }
    }
  }

  // Source-min backfill: if the primary recency window doesn't have enough
  // viable candidates of one source after revalidation drops, reach further
  // back (up to 30 days) for that source only. This satisfies Mark's "≥2 per
  // source when total>3" rule on a Slack-quiet or Front-quiet day. Items
  // pulled from the wider window go through the same revalidation gate.
  if (args.max > 3 && args.sourceMin > 0) {
    const SUPPLEMENTAL_LOOKBACK_HOURS = 24 * 30;
    const sourceCounts = new Map();
    for (const e of escalations) {
      const s = e.source || "slack";
      sourceCounts.set(s, (sourceCounts.get(s) ?? 0) + 1);
    }
    for (const src of ["slack", "front"]) {
      const have = sourceCounts.get(src) ?? 0;
      if (have >= args.sourceMin) continue;
      const need = args.sourceMin - have;
      const excludeIds = escalations.map(e => e.id);
      const supplemental = loadSupplementalFromSource(
        db, recipient, args.minSeverity, src, SUPPLEMENTAL_LOOKBACK_HOURS, excludeIds, args.ignoreDeliveries,
      );
      if (supplemental.length === 0) continue;
      console.log(`  ↑ source-min backfill: need ${need} more ${src}, considering ${supplemental.length} from last 30d`);
      let added = 0;
      for (const cand of supplemental) {
        if (added >= need) break;
        // Front items don't go through Slack-thread revalidation; trust them.
        if (src === "front") {
          escalations.push({ ...cand, _revalidation: { statusNote: "_supplemental: pulled from extended (30d) window to satisfy source-min_" } });
          added += 1;
          console.log(`  ↑ added Front #${cand.id} sev${cand.max_severity}`);
          continue;
        }
        // Slack: revalidate first.
        if (router && !args.noRevalidate) {
          const result = await revalidateSlackEscalation(db, cand, router);
          try { recordRevalidation(db, cand.id, result); } catch {}
          if (result.shouldDrop) {
            console.log(`  ⊘ supplemental #${cand.id} dropped: ${result.dropReason}`);
            continue;
          }
          escalations.push({ ...cand, _revalidation: result });
        } else {
          escalations.push({ ...cand, _revalidation: null });
        }
        added += 1;
        console.log(`  ↑ added Slack #${cand.id} sev${cand.max_severity} ${cand.last_evidence_at?.slice(0,10)}`);
      }
    }
  }

  // Source-balanced final selection. When delivering >3 items, enforce a
  // minimum of args.sourceMin per source so the digest doesn't go monosource
  // on a Front-heavy or Slack-heavy day. Operates on the FULL post-revalidation
  // pool so it can reach lower-scored items in an underrepresented source.
  escalations = rankAndBalance(escalations, args.max, args.sourceMin);
  if (args.limit) escalations = escalations.slice(0, args.limit);

  if (escalations.length === 0) {
    console.log(`${exec.display_name}: no new escalations to deliver`);
    return { sent: 0, skipped: 0 };
  }
  console.log(`${exec.display_name}: ${totalCandidates} pending → top ${escalations.length} after rank+revalidate+cap`);

  let imChannel = null;
  if (!args.dryRun) {
    imChannel = await openIm(recipient);
    if (!imChannel) {
      console.error(`${exec.display_name}: failed to open IM`);
      return { sent: 0, skipped: 0 };
    }
  }

  let sent = 0;
  for (const esc of escalations) {
    const sources = args.dryRun ? [] : await resolveSourceMessages(db, esc, 3);
    const headlineBlocks = buildHeadlineBlocks(esc, sources);
    const text = buildPlaintextFallback(esc);
    if (args.dryRun) {
      console.log(`[DRY] → ${exec.display_name} : ${text}`);
      sent += 1;
      continue;
    }
    try {
      // 1. Post the tight headline as the main DM message
      const result = await postMessage({ channel: imChannel, text, blocks: headlineBlocks });
      // Plain INSERT (not OR IGNORE) — multiple delivery rows per (recipient,
      // escalation_id) are valid now, one per re-delivery event after a new
      // customer follow-up. The dedupe in loadPendingEscalationsForRecipient
      // uses MAX(delivered_at) so we keep history without losing dedupe.
      db.prepare(`
        INSERT INTO digest_deliveries (
          exec_employee_id, recipient_slack_user_id, escalation_id,
          bot_message_channel, bot_message_ts, delivered_at, delivery_method
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        exec.employee_id,
        recipient,
        esc.id,
        result.channel,
        result.ts,
        nowIso(),
        getWriteTokenKind() === "bot" ? "bot_dm" : "user_dm",
      );
      // 2. Post the detail as a thread reply (so it's available on demand
      //    but doesn't crowd the DM list view). For Front escalations,
      //    append the full conversation transcript so execs without Front
      //    access can read the source thread inline.
      const detailBlocks = buildDetailBlocks(esc, sources);
      if (esc.source === "front" && esc.front_conversation_id) {
        const transcriptBlocks = buildFrontTranscriptBlocks(db, esc.front_conversation_id);
        detailBlocks.push(...transcriptBlocks);
      }
      try {
        await postMessage({
          channel: result.channel,
          text: `Detail for: ${esc.display_title ?? "escalation #" + esc.id}`,
          blocks: detailBlocks,
          threadTs: result.ts,
        });
      } catch (err) {
        console.warn(`  detail thread reply failed for #${esc.id}: ${err.message}`);
      }
      console.log(`✓ ${exec.display_name} ← #${esc.id} (sev ${esc.max_severity})`);
      sent += 1;
    } catch (err) {
      console.error(`✗ ${exec.display_name} ← #${esc.id}: ${err.message}`);
    }
  }
  return { sent, skipped: 0 };
}

async function main() {
  const args = parseArgs(process.argv);
  const db = openDatabase();
  const tokenKind = getWriteTokenKind();
  console.log(`Write token: ${tokenKind} ${tokenKind === "user" ? "(user-token fallback — messages will post AS the user, not a bot)" : ""}`);
  if (args.dryRun) console.log("(dry run — no Slack calls)");

  let execs = db.prepare(`SELECT * FROM watched_execs WHERE active = 1 AND slack_user_id IS NOT NULL`).all();
  if (args.recipient) execs = execs.filter(e => e.display_name.toLowerCase().includes(args.recipient.toLowerCase()));
  console.log(`Delivering to ${execs.length} exec(s): ${execs.map(e => e.display_name).join(", ")}`);

  // Build the multi-token Slack router once per run. Used to revalidate
  // Slack-sourced escalations against current thread state. If router build
  // fails (e.g. token down), fall back to no revalidation rather than blocking
  // delivery.
  let router = null;
  if (!args.noRevalidate) {
    // Prefer cached router (instant) — falls back to full enumeration only
    // when the cache is empty (first-ever run on this DB).
    try {
      router = buildRouterFromCache(db);
      console.log(`[digest] revalidation enabled (${router.identified.length} token(s), cached routing for ${router.accessibleChannels().length} channels)`);
    } catch (cacheErr) {
      console.log(`[digest] no router cache (${cacheErr.message}); building fresh — this takes ~2-3 min`);
      try {
        router = await buildRouter(db);
        console.log(`[digest] revalidation enabled (${router.identified.length} token(s))`);
      } catch (err) {
        console.warn(`[digest] router build failed (${err.message}); skipping revalidation`);
      }
    }
  }

  let total = 0;
  for (const exec of execs) {
    const { sent } = await deliverToExec(db, exec, args, router);
    total += sent;
  }
  console.log(`\nTotal: ${total} message(s) sent.`);
}

try { await main(); } catch (e) { console.error(e instanceof Error ? e.stack : String(e)); process.exit(1); }
