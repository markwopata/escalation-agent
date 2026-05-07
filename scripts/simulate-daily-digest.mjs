// Daily-digest simulator. Replays "what would have been delivered each
// morning at 8 AM" for the past N days, per active watched_exec recipient.
//
// Each day D:
//   - Treat D 08:00 local as the "now" cutoff
//   - Eligible escalations:
//       (a) created_at <= D 08:00            (existed when digest would've run)
//       (b) last_evidence_at within 24h of D 08:00  (recency window)
//       (c) NOT delivered to that recipient before D 08:00
//       (d) per-recipient access filter (Front broadcasts; Slack public broadcasts;
//           Slack private requires channel_token_access.is_member=1)
//       (e) max_severity >= min severity (default 3)
//   - Rank with rankAndCap (default 6)
//   - Print + persist to reports/daily-digest-simulation.md
//
// Caveat: this approximates day-by-day state from the current snapshot. It
// does NOT replay the exact ordering of investigations/rollups that would
// have happened if the agent had been running daily. For our purposes —
// "is the cadence and population sane?" — that's good enough.
//
// Usage:
//   node scripts/simulate-daily-digest.mjs                         # 5 days, all active execs
//   node scripts/simulate-daily-digest.mjs --days 7
//   node scripts/simulate-daily-digest.mjs --recipient mark
//   node scripts/simulate-daily-digest.mjs --max 4                 # cap per day
//   node scripts/simulate-daily-digest.mjs --min-severity 4

import process from "node:process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "./lib/db.mjs";
import { repoRoot } from "./lib/load-env.mjs";
import { rankAndCap } from "./lib/escalation-score.mjs";

function parseArgs(argv) {
  const args = {
    days: 5, recipient: null, max: 6, minSeverity: 3, hour: 8,
    sinceHours: 24,         // recency window
    agingDays: 0,           // 0 = disabled. If N>0, pending escalations stale-but-undelivered for N+ days resurface
    steadyState: false,     // drop created_at <= as_of filter (model continuous operation)
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--days") args.days = Number(argv[++i]);
    else if (a === "--recipient") args.recipient = argv[++i];
    else if (a === "--max") args.max = Number(argv[++i]);
    else if (a === "--min-severity") args.minSeverity = Number(argv[++i]);
    else if (a === "--hour") args.hour = Number(argv[++i]);
    else if (a === "--since-hours") args.sinceHours = Number(argv[++i]);
    else if (a === "--aging-days") args.agingDays = Number(argv[++i]);
    else if (a === "--steady-state") args.steadyState = true;
  }
  return args;
}

function dayCutoffs(daysBack, hour) {
  // Returns array of ISO timestamps for hour:00 UTC each of the last N days,
  // most-recent-first. We use UTC for stability across DST etc.
  const cutoffs = [];
  const now = new Date();
  for (let i = 0; i < daysBack; i += 1) {
    const d = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i,
      hour, 0, 0, 0,
    ));
    cutoffs.push(d.toISOString());
  }
  return cutoffs.reverse(); // oldest first for chronological output
}

function loadEligible(db, recipientSlackUserId, asOfIso, opts) {
  const { sinceHours = 24, minSeverity = 3, agingDays = 0, steadyState = false } = opts;
  const hasAccessRows = !!db.prepare(
    "SELECT 1 FROM channel_token_access WHERE token_owner_slack_id = ? LIMIT 1"
  ).get(recipientSlackUserId);
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
  // steadyState=true: drop the `created_at <= as_of` filter so we approximate
  // what would have surfaced if rollup had been running continuously rather
  // than the all-on-today snapshot we have. This is closer to real ongoing
  // operation but is genuinely a what-if.
  const createdAtClause = steadyState ? `` : `AND e.created_at <= @as_of`;
  // Two ways an escalation can be eligible on day @as_of:
  //   (A) Recent: last_evidence_at within recency window AND <= as_of.
  //   (B) Aging resurface: pending, agingDays>0, never delivered or last
  //       delivery was >agingDays ago, and created_at >= as_of - 90 days
  //       (don't resurface ancient backlog forever).
  let recencyClause = `e.last_evidence_at >= datetime(@as_of, '-' || @since_hours || ' hours')
                       AND e.last_evidence_at <= @as_of`;
  if (agingDays > 0) {
    recencyClause = `(
       (e.last_evidence_at >= datetime(@as_of, '-' || @since_hours || ' hours')
        AND e.last_evidence_at <= @as_of)
       OR
       (e.last_evidence_at < datetime(@as_of, '-' || @since_hours || ' hours')
        AND e.last_evidence_at >= datetime(@as_of, '-90 days')
        AND (
          d_recent.id IS NULL
          OR d_recent.delivered_at < datetime(@as_of, '-' || @aging_days || ' days')
        )
       )
    )`;
  }
  // d_recent is the "did we deliver this to them recently?" join. Used by
  // both the aging condition and as a hard skip if delivered already (we
  // skip an item if it's already in their inbox).
  return db.prepare(`
    SELECT e.id, e.cluster_type, e.primary_criterion, e.criteria_observed_json,
           e.max_severity, e.evidence_message_count,
           e.representative_exec_summary, e.display_title, e.display_title_short_summary,
           e.first_evidence_at, e.last_evidence_at, e.created_at,
           e.author_slack_user_id, e.slack_channel_id,
           e.source, e.front_conversation_id, e.front_inbox_id,
           c.name AS channel_name, fc.inbox_name AS front_inbox_name,
           d_recent.delivered_at AS prior_delivered_at
    FROM escalations e
    LEFT JOIN channels c ON c.slack_channel_id = e.slack_channel_id
    LEFT JOIN front_conversations fc ON fc.conversation_id = e.front_conversation_id
    LEFT JOIN digest_deliveries d_recent
      ON d_recent.recipient_slack_user_id = @recipient
     AND d_recent.escalation_id = e.id
     AND d_recent.delivered_at < @as_of
    WHERE e.exec_action = 'pending'
      AND e.max_severity >= @min_severity
      ${createdAtClause}
      AND ${recencyClause}
      ${accessFilter}
    ORDER BY e.max_severity DESC, e.last_evidence_at DESC
  `).all({
    recipient: recipientSlackUserId,
    min_severity: minSeverity,
    as_of: asOfIso,
    since_hours: sinceHours,
    aging_days: agingDays,
  });
}

function fmtDay(isoDate) {
  return isoDate.slice(0, 10);
}

function fmtTime(isoDate) {
  return isoDate?.slice(0, 16).replace("T", " ") ?? "?";
}

const SEV_EMOJI = { 5: "🚨", 4: "🔴", 3: "🟠" };

function renderEsc(esc) {
  const emoji = SEV_EMOJI[esc.max_severity] ?? "";
  const src = esc.source === "front" ? "[FRONT]" : "[SLACK]";
  const where = esc.source === "front"
    ? `inbox: ${esc.front_inbox_name ?? "?"}`
    : `#${esc.channel_name ?? "?"}`;
  const title = esc.display_title ?? `Escalation #${esc.id}`;
  const head = `${emoji} sev ${esc.max_severity} #${esc.id} ${src} score=${esc._score?.score ?? "?"} — ${title}`;
  const meta = `   ${esc.primary_criterion} · ${where} · last_evidence: ${fmtTime(esc.last_evidence_at)}`;
  const summary = esc.display_title_short_summary
    ? `   > ${esc.display_title_short_summary.slice(0, 200)}`
    : (esc.representative_exec_summary
        ? `   > ${esc.representative_exec_summary.slice(0, 200)}`
        : "");
  return [head, meta, summary].filter(Boolean).join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  const db = openDatabase();

  let execs = db.prepare(`
    SELECT employee_id, display_name, slack_user_id
    FROM watched_execs
    WHERE active = 1 AND slack_user_id IS NOT NULL
  `).all();
  if (args.recipient) {
    execs = execs.filter(e => e.display_name.toLowerCase().includes(args.recipient.toLowerCase()));
  }
  if (execs.length === 0) {
    console.log("No active recipients matched.");
    return;
  }

  const cutoffs = dayCutoffs(args.days, args.hour);

  const lines = [];
  lines.push(`# Daily Digest Simulation`);
  lines.push(`*Replays the past ${args.days} days as if the digest had been delivered at ${String(args.hour).padStart(2, "0")}:00 UTC each day.*`);
  lines.push(``);
  lines.push(`Recipients: ${execs.map(e => e.display_name).join(", ")}`);
  lines.push(`Window: ${args.sinceHours}h on \`last_evidence_at\` · max ${args.max}/recipient · min severity ${args.minSeverity}`);
  if (args.agingDays > 0) lines.push(`Aging resurface: pending items >${args.agingDays}d since last delivery re-eligible`);
  if (args.steadyState) lines.push(`Steady-state mode: \`created_at <= as_of\` filter dropped (models continuous operation)`);
  lines.push(``);

  const stdoutBuf = [];

  for (const exec of execs) {
    const recipientHeader = `## ${exec.display_name}`;
    lines.push(recipientHeader);
    stdoutBuf.push(`\n${"=".repeat(60)}\n${exec.display_name}\n${"=".repeat(60)}`);

    const counts = [];
    // Track which escalation IDs have been "simulated delivered" already so
    // the same item doesn't keep showing up day after day. Real digest does
    // this via the digest_deliveries table; we simulate it in-memory because
    // we don't want the simulator to write to the production table.
    const simulatedDelivered = new Set();
    for (const cutoff of cutoffs) {
      let eligible = loadEligible(db, exec.slack_user_id, cutoff, {
        sinceHours: args.sinceHours,
        minSeverity: args.minSeverity,
        agingDays: args.agingDays,
        steadyState: args.steadyState,
      });
      // Apply sim-delivery exclusion (would-have-been-delivered earlier in this run)
      eligible = eligible.filter(e => !simulatedDelivered.has(e.id));
      const top = rankAndCap(eligible, args.max);
      for (const t of top) simulatedDelivered.add(t.id);
      counts.push({ day: fmtDay(cutoff), eligible: eligible.length, sent: top.length });

      lines.push(``);
      lines.push(`### ${fmtDay(cutoff)}  ·  ${eligible.length} eligible → top ${top.length}`);
      stdoutBuf.push(`\n--- ${fmtDay(cutoff)} ---  eligible: ${eligible.length}  delivered: ${top.length}`);
      if (top.length === 0) {
        lines.push(`_(no escalations met the recency window today)_`);
        stdoutBuf.push(`  (none)`);
        continue;
      }
      for (const e of top) {
        lines.push(`- **#${e.id}** ${SEV_EMOJI[e.max_severity] ?? ""} sev ${e.max_severity} score=${e._score?.score} — ${e.display_title ?? "untitled"}`);
        lines.push(`  - ${e.source === "front" ? "[FRONT] " + (e.front_inbox_name ?? "?") : "[SLACK] #" + (e.channel_name ?? "?")} · ${e.primary_criterion} · last: ${fmtTime(e.last_evidence_at)}`);
        if (e.display_title_short_summary) {
          lines.push(`  - ${e.display_title_short_summary.slice(0, 240)}`);
        }
        stdoutBuf.push(renderEsc(e));
      }
    }

    // Daily count summary table
    lines.push(``);
    lines.push(`### ${exec.display_name} — daily counts`);
    lines.push(``);
    lines.push(`| Day | Eligible | Delivered |`);
    lines.push(`|---|---|---|`);
    for (const c of counts) lines.push(`| ${c.day} | ${c.eligible} | ${c.sent} |`);
    const avg = counts.reduce((s, c) => s + c.sent, 0) / counts.length;
    lines.push(``);
    lines.push(`Average delivered/day: **${avg.toFixed(1)}**`);
    stdoutBuf.push(`\nAverage delivered/day for ${exec.display_name}: ${avg.toFixed(1)}`);
  }

  // Write output
  const outPath = resolve(repoRoot, "reports", "daily-digest-simulation.md");
  mkdirSync(resolve(outPath, ".."), { recursive: true });
  writeFileSync(outPath, lines.join("\n"), "utf8");

  console.log(stdoutBuf.join("\n"));
  console.log(`\n\nReport: ${outPath}`);
}

await main();
