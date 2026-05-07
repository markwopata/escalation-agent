// Front EDA spike: sample customer-facing inboxes, render transcripts,
// run Tier A (Haiku) using the current active_criteria + prompt_overrides,
// and write a markdown report so we can hand-eyeball flags.
//
// Usage:
//   node scripts/front-spike.mjs [--limit 200] [--days 7] [--out reports/front-spike.md]
//
// No DB writes — this is a read-only EDA pass. Results dumped to JSONL +
// markdown so we can review and tune before committing to ingestion plumbing.

import process from "node:process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { openDatabase } from "./lib/db.mjs";
import { loadLocalEnv, repoRoot } from "./lib/load-env.mjs";
import { executeSqlThroughFrostyWithWarehouse } from "./lib/frosty-client.mjs";
import {
  buildSystemPrompt,
  loadActiveCriterionCodes,
} from "./lib/triage-prompt.mjs";
import { buildTriageResultSchema, TRIAGE_MODEL } from "./lib/triage.mjs";
import { applyRoleFix } from "./lib/front-role-fix.mjs";

loadLocalEnv();

// Three inbox tiers we sample from. The spike pulls a few tens of
// conversations from each. Branch-level inboxes are resolved dynamically
// via top-N-by-volume so we don't have to maintain a hardcoded list.
const CUSTOMER_FACING_INBOXES = [
  "Customer Support",
  "T3 Support",
  "Billing & Payments",
  "Fleet",
  "ES Track Support",
  "Customer Support (Text Messaging)",
];
const BACK_OFFICE_INBOXES = [
  "AP - Invoicing",
  "Branch Orders",
  "Fleet Invoicing",
  "Vendors",
  "Logistics",
  "Credit",
];

async function fetchTopBranchInboxes({ days, count }) {
  // Branch-level inboxes follow "<Location> [- Solution-line] - <Sales|Service|Parts>".
  // We rank by 7-day volume and take the top N, stratifying so each role
  // gets representation rather than letting Sales (the most common) eat
  // the whole list.
  const sql = `WITH ranked AS (
    SELECT INBOX_NAME,
      CASE
        WHEN INBOX_NAME ILIKE '% - Sales' THEN 'Sales'
        WHEN INBOX_NAME ILIKE '% - Service' THEN 'Service'
        WHEN INBOX_NAME ILIKE '% - Parts' THEN 'Parts'
      END AS role,
      COUNT(*) AS conv_count,
      ROW_NUMBER() OVER (
        PARTITION BY CASE
          WHEN INBOX_NAME ILIKE '% - Sales' THEN 'Sales'
          WHEN INBOX_NAME ILIKE '% - Service' THEN 'Service'
          WHEN INBOX_NAME ILIKE '% - Parts' THEN 'Parts'
        END
        ORDER BY COUNT(*) DESC
      ) AS rn
    FROM PEOPLE_ANALYTICS.FRONT_ESCALATION.FRONT_ESCALATION_CONVERSATION_SUMMARY
    WHERE CONVERSATION_CREATED_AT >= DATEADD(day, -${days}, CURRENT_TIMESTAMP())
      AND (INBOX_NAME ILIKE '% - Sales' OR INBOX_NAME ILIKE '% - Service' OR INBOX_NAME ILIKE '% - Parts')
    GROUP BY INBOX_NAME, role
  )
  SELECT INBOX_NAME, role, conv_count, rn FROM ranked WHERE rn <= ${count}`;
  const r = await executeSqlThroughFrostyWithWarehouse(sql.trim());
  if (!r.success) throw new Error(`Branch inbox query failed: ${r.error}`);
  // Stratify: half Sales, third Service, sixth Parts; fill from top of each
  const sales = r.data.filter(x => x.ROLE === 'Sales');
  const service = r.data.filter(x => x.ROLE === 'Service');
  const parts = r.data.filter(x => x.ROLE === 'Parts');
  const targetSales = Math.round(count * 0.6);
  const targetService = Math.round(count * 0.3);
  const targetParts = count - targetSales - targetService;
  const picked = [
    ...sales.slice(0, targetSales),
    ...service.slice(0, targetService),
    ...parts.slice(0, targetParts),
  ].slice(0, count);
  return picked.map(x => x.INBOX_NAME);
}

function parseArgs(argv) {
  const args = {
    perInbox: 25, days: 7, branchCount: 0, includeBackOffice: false,
    inboxList: null, skipDefaults: false,
    out: "reports/front-spike.md",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--per-inbox") args.perInbox = Number(argv[++i]);
    else if (a === "--days") args.days = Number(argv[++i]);
    else if (a === "--branch-count") args.branchCount = Number(argv[++i]);
    else if (a === "--include-back-office") args.includeBackOffice = true;
    else if (a === "--inbox-list") args.inboxList = argv[++i].split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--skip-defaults") args.skipDefaults = true;
    else if (a === "--out") args.out = argv[++i];
  }
  return args;
}

async function fetchConversationSample({ perInbox, days, inboxes }) {
  // Stratified sample across inboxes — perInbox conversations from each.
  // Filters: multi-turn AND at least one inbound (skips pure outbound blasts
  // and one-shot bot notifications).
  const inboxList = inboxes.map(i => `'${i.replace(/'/g, "''")}'`).join(",");
  const sql = `
    WITH ranked AS (
      SELECT
        s.CONVERSATION_ID,
        s.INBOX_NAME,
        s.CONVERSATION_SUBJECT,
        s.CONVERSATION_CREATED_AT,
        s.CURRENT_STATUS,
        s.MINUTES_TO_FIRST_REPLY,
        s.TOTAL_MESSAGE_COUNT,
        s.INBOUND_MESSAGE_COUNT,
        s.OUTBOUND_MESSAGE_COUNT,
        s.LAST_MESSAGE_AT,
        ROW_NUMBER() OVER (PARTITION BY s.INBOX_NAME ORDER BY HASH(s.CONVERSATION_ID)) AS rn
      FROM PEOPLE_ANALYTICS.FRONT_ESCALATION.FRONT_ESCALATION_CONVERSATION_SUMMARY s
      WHERE s.CONVERSATION_CREATED_AT >= DATEADD(day, -${days}, CURRENT_TIMESTAMP())
        AND s.INBOX_NAME IN (${inboxList})
        AND s.TOTAL_MESSAGE_COUNT >= 2
        AND s.INBOUND_MESSAGE_COUNT >= 1
    )
    SELECT *
    FROM ranked
    WHERE rn <= ${perInbox}
  `;
  const result = await executeSqlThroughFrostyWithWarehouse(sql.trim());
  if (!result.success) throw new Error(`Sample query failed: ${result.error}`);
  return result.data;
}

async function fetchThread(conversationId) {
  // THREAD_FLAT has each message_id duplicated across 2 distinct turn_index
  // values (data quality issue; flagged to data eng). Dedup on message_id.
  const sql = `
    SELECT MESSAGE_ID, MIN(TURN_INDEX) AS TURN_INDEX, ANY_VALUE(ROLE) AS ROLE,
           ANY_VALUE(AUTHOR_ID) AS AUTHOR_ID, ANY_VALUE(CREATED_AT) AS CREATED_AT,
           ANY_VALUE(TEXT) AS TEXT
    FROM PEOPLE_ANALYTICS.FRONT_ESCALATION.FRONT_ESCALATION_THREAD_FLAT
    WHERE CONVERSATION_ID = '${conversationId.replace(/'/g, "''")}'
    GROUP BY MESSAGE_ID
    ORDER BY TURN_INDEX
  `;
  const result = await executeSqlThroughFrostyWithWarehouse(sql.trim());
  if (!result.success) throw new Error(`Thread query failed for ${conversationId}: ${result.error}`);
  // Override role labels — Andrew's pipeline mislabels ES employees as
  // 'customer' when they email-in (no Front teammate AUTHOR_ID).
  return applyRoleFix(result.data);
}

function elapsedHuman(iso) {
  if (!iso) return "?";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "in the future";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function renderTranscript(turns) {
  const lines = [];
  for (const t of turns) {
    const when = (t.CREATED_AT ?? "").slice(0, 19).replace("T", " ");
    const role = t.ROLE === "customer" ? "CUSTOMER" : "ES_EMPLOYEE";
    const text = (t.TEXT ?? "").trim().slice(0, 1200);
    lines.push(`[${when}] ${role}: ${text}`);
  }
  return lines.join("\n\n");
}

// Build the Tier A user content for a Front conversation. Mirrors the Slack
// version's shape — channel/role context, conversation arc, the message
// being triaged — but the unit of work is a whole conversation, not a single
// message. We frame "the conversation" as the message-to-triage and let the
// transcript carry the role context.
function buildFrontUserContent(conv, turns) {
  const lines = [];
  lines.push(`SOURCE: Front (customer-facing email/chat inbox).`);
  lines.push(`Inbox: "${conv.INBOX_NAME}" — ${describeInbox(conv.INBOX_NAME)}`);
  lines.push(`Subject: ${conv.CONVERSATION_SUBJECT ?? "(no subject)"}`);
  lines.push(`Status: ${conv.CURRENT_STATUS ?? "?"}`);
  lines.push(`Created: ${conv.CONVERSATION_CREATED_AT?.slice(0,19) ?? "?"} (${elapsedHuman(conv.CONVERSATION_CREATED_AT)} ago)`);
  if (conv.MINUTES_TO_FIRST_REPLY != null) {
    const m = Number(conv.MINUTES_TO_FIRST_REPLY);
    if (m < 0) lines.push(`First reply: ES sent first (outbound-initiated; ${Math.abs(Math.round(m))}m before any inbound).`);
    else lines.push(`Minutes to first reply: ${Math.round(m)}m.`);
  } else {
    lines.push(`Minutes to first reply: NEVER REPLIED.`);
  }
  lines.push(`Message counts: total=${conv.TOTAL_MESSAGE_COUNT}, inbound=${conv.INBOUND_MESSAGE_COUNT}, outbound=${conv.OUTBOUND_MESSAGE_COUNT}.`);
  lines.push("");
  lines.push("FRONT-SPECIFIC INTERPRETATION GUIDE");
  lines.push("- Roles in the transcript: CUSTOMER (external) or ES_EMPLOYEE (EquipmentShare team).");
  lines.push("- Unlike Slack, customer voice IS direct here. 'sales_relaying_customer_pain' becomes 'customer expressing pain themselves' — same signal, more direct.");
  lines.push("");
  lines.push("CRITICAL: WORKFLOW NOTIFICATIONS vs HUMAN MESSAGES");
  lines.push("Many Front conversations are SYSTEM-GENERATED workflow notifications, not human conversations. These should NEVER be flagged regardless of reply status:");
  lines.push("- Templated subjects like 'Rentals #X have been off-rented for Y', 'Rentals off-rent scheduled for Z', 'New Parts Request from {Branch}', 'Customer requesting service' (when body is just a structured form), 'INVOICE_X_Y', 'Polaris Invoice number N', 'Doosan Invoice N', vendor invoice arrivals.");
  lines.push("- Telematics alerts: 'Ignition On Alert', 'Tracker Removed Alert', 'Speed Alert' (Trackunit auto-emails).");
  lines.push("- One-off auto-confirmations or system bounce notices.");
  lines.push("These are system-to-system or system-to-record-keeping. Nobody is expected to reply on Front. Mark as 'none' even if there's been no reply for days.");
  lines.push("");
  lines.push("REAL DEAD-AIR (FLAG WITH HIGH PRECISION)");
  lines.push("A HUMAN (customer or internal employee) wrote a message asking a question, reporting an issue, or following up — and got no resolution. Specifically:");
  lines.push("- 'help_channel_dead_air' applies when a HUMAN customer or HUMAN employee writes and there's no reply, especially if they followed up. Customer follow-ups (>=2 inbound from same customer) are the strongest signal.");
  lines.push("- 'corporate_obstructing_field' applies when ES_EMPLOYEE responses are process-bouncing ('forward to coi@', 'submit through portal', 'not our team') instead of solving.");
  lines.push("- For inbound-only conversations: ONLY flag if the message is human-authored. If the body reads like a templated workflow email (structured, no greeting, no question, just data), do NOT flag — even if it sat for days.");
  lines.push("");
  lines.push("=== CONVERSATION TO TRIAGE ===");
  lines.push(renderTranscript(turns));
  return lines.join("\n");
}

function describeInbox(name) {
  const map = {
    "Customer Support": "general customer support — escalations, status questions, account issues",
    "T3 Support": "T3OS product support — customer + field reports of platform issues",
    "Billing & Payments": "customer billing and payment questions — invoices, charges, refunds",
    "Fleet": "fleet-related customer issues — equipment failures, off-rents, deliveries",
    "ES Track Support": "telematics product support — Trackunit, GPS, asset tracking",
    "Customer Support (Text Messaging)": "SMS-based customer support",
    "AP - Invoicing": "back-office accounts payable / invoicing",
    "Branch Orders": "internal branch order management",
    "Fleet Invoicing": "fleet billing back-office",
    "Vendors": "vendor communications",
    "Logistics": "shipping/logistics coordination",
    "Credit": "customer credit hold / DNR resolution",
  };
  if (map[name]) return map[name];
  // Branch-level pattern: "<Location> - [Solution-line] - <Sales|Service|Parts>"
  if (/ - Sales$/i.test(name))   return "branch-level Sales — local rep handling customer rentals/sales for one location";
  if (/ - Service$/i.test(name)) return "branch-level Service — local mechanics/service handling repairs and maintenance for one location";
  if (/ - Parts$/i.test(name))   return "branch-level Parts — local parts desk fulfilling parts requests for one location";
  return "(unknown inbox role)";
}

let cachedClient = null;
function getClient() {
  if (!cachedClient) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set.");
    cachedClient = new Anthropic();
  }
  return cachedClient;
}

async function triageOne(systemPrompt, schema, conv, turns) {
  const client = getClient();
  const userContent = buildFrontUserContent(conv, turns);
  const start = Date.now();
  const response = await client.messages.parse({
    model: TRIAGE_MODEL,
    max_tokens: 1024,
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userContent }],
    output_config: { format: zodOutputFormat(schema) },
  });
  return {
    parsed: response.parsed_output,
    usage: response.usage,
    duration_ms: Date.now() - start,
    user_content_chars: userContent.length,
  };
}

function renderMarkdown({ args, conversations, results, summary }) {
  const lines = [];
  lines.push(`# Front EDA Spike — ${new Date().toISOString().slice(0,10)}`);
  lines.push("");
  lines.push(`Sample: ${args.limit} customer-facing conversations, last ${args.days} days, ${CUSTOMER_FACING_INBOXES.length} inboxes.`);
  lines.push(`Triage model: ${TRIAGE_MODEL}, prompt version: ${summary.promptVersion}.`);
  lines.push("");
  lines.push("## Summary");
  lines.push(`- Conversations analyzed: ${results.length}`);
  lines.push(`- Flagged (worth_deeper_look=true): ${summary.flagged} (${(100 * summary.flagged / results.length).toFixed(1)}%)`);
  lines.push(`- Total cost (estimate): ~$${summary.estCostUsd.toFixed(2)}`);
  lines.push(`- Avg user prompt size: ${Math.round(summary.avgUserChars)} chars`);
  lines.push("");
  lines.push("## Severity distribution");
  lines.push("| Sev | Count |");
  lines.push("|---|---|");
  for (const sev of [1,2,3,4,5]) {
    lines.push(`| ${sev} | ${summary.bySeverity[sev] ?? 0} |`);
  }
  lines.push("");
  lines.push("## Criteria firing");
  lines.push("| Criterion | Count |");
  lines.push("|---|---|");
  for (const [code, n] of Object.entries(summary.byCriterion).sort((a,b) => b[1] - a[1])) {
    lines.push(`| \`${code}\` | ${n} |`);
  }
  lines.push("");
  lines.push("## By inbox");
  lines.push("| Inbox | N | Flagged | % |");
  lines.push("|---|---|---|---|");
  for (const [inbox, stats] of Object.entries(summary.byInbox).sort((a,b) => b[1].n - a[1].n)) {
    lines.push(`| ${inbox} | ${stats.n} | ${stats.flagged} | ${(100*stats.flagged/stats.n).toFixed(0)}% |`);
  }
  lines.push("");
  // Exemplars: show the highest-severity flags + a few "none" baselines
  const flagged = results.filter(r => r.parsed.worth_deeper_look)
    .sort((a,b) => b.parsed.severity - a.parsed.severity)
    .slice(0, 12);
  const baselines = results.filter(r => !r.parsed.worth_deeper_look).slice(0, 3);
  lines.push("## Flagged exemplars (top 12 by severity)");
  for (const r of flagged) {
    lines.push("");
    lines.push(`### sev ${r.parsed.severity} · \`${r.parsed.primary_criterion}\` · ${r.conv.INBOX_NAME}`);
    lines.push(`> **Subject:** ${r.conv.CONVERSATION_SUBJECT ?? "(none)"}`);
    lines.push(`> **First-reply:** ${r.conv.MINUTES_TO_FIRST_REPLY == null ? "NEVER" : Math.round(Number(r.conv.MINUTES_TO_FIRST_REPLY)) + "m"} · **Status:** ${r.conv.CURRENT_STATUS} · **Turns:** ${r.turns.length}`);
    lines.push(`> **Reason:** ${r.parsed.reason}`);
    lines.push("");
    lines.push("```");
    lines.push(renderTranscript(r.turns).slice(0, 2400));
    lines.push("```");
  }
  lines.push("");
  lines.push("## Baseline (un-flagged) samples for calibration");
  for (const r of baselines) {
    lines.push("");
    lines.push(`### ${r.conv.INBOX_NAME} — ${r.conv.CONVERSATION_SUBJECT ?? "(none)"}`);
    lines.push(`> **Reason:** ${r.parsed.reason}`);
    lines.push("```");
    lines.push(renderTranscript(r.turns).slice(0, 1200));
    lines.push("```");
  }
  return lines.join("\n");
}

function summarize(results) {
  const summary = { flagged: 0, bySeverity: {}, byCriterion: {}, byInbox: {}, totalInputTokens: 0, totalOutputTokens: 0, totalCacheRead: 0, totalCacheCreate: 0, totalUserChars: 0 };
  for (const r of results) {
    if (r.parsed.worth_deeper_look) summary.flagged += 1;
    summary.bySeverity[r.parsed.severity] = (summary.bySeverity[r.parsed.severity] ?? 0) + 1;
    const code = r.parsed.primary_criterion;
    summary.byCriterion[code] = (summary.byCriterion[code] ?? 0) + 1;
    const inbox = r.conv.INBOX_NAME;
    summary.byInbox[inbox] = summary.byInbox[inbox] ?? { n: 0, flagged: 0 };
    summary.byInbox[inbox].n += 1;
    if (r.parsed.worth_deeper_look) summary.byInbox[inbox].flagged += 1;
    summary.totalInputTokens += r.usage?.input_tokens ?? 0;
    summary.totalOutputTokens += r.usage?.output_tokens ?? 0;
    summary.totalCacheRead += r.usage?.cache_read_input_tokens ?? 0;
    summary.totalCacheCreate += r.usage?.cache_creation_input_tokens ?? 0;
    summary.totalUserChars += r.user_content_chars ?? 0;
  }
  // Haiku 4.5 pricing (per 1M tokens): input $1, cache write $1.25, cache read $0.10, output $5
  summary.estCostUsd = (summary.totalInputTokens * 1 + summary.totalCacheCreate * 1.25 + summary.totalCacheRead * 0.10 + summary.totalOutputTokens * 5) / 1_000_000;
  summary.avgUserChars = results.length ? summary.totalUserChars / results.length : 0;
  return summary;
}

async function main() {
  const args = parseArgs(process.argv);
  const db = openDatabase();
  const { prompt: systemPrompt } = buildSystemPrompt(db);
  const codes = loadActiveCriterionCodes(db);
  const schema = buildTriageResultSchema(codes);
  const promptVersion = `triage-v5-active`; // tag, not the hash, since this is a spike

  let inboxes = args.skipDefaults ? [] : [...CUSTOMER_FACING_INBOXES];
  if (args.includeBackOffice) inboxes.push(...BACK_OFFICE_INBOXES);
  if (args.branchCount > 0) {
    const branch = await fetchTopBranchInboxes({ days: args.days, count: args.branchCount });
    inboxes.push(...branch);
    console.log(`Resolved top ${branch.length} branch-level inboxes by ${args.days}-day volume.`);
  }
  if (args.inboxList) inboxes.push(...args.inboxList);
  // Dedup in case a name appears in multiple categories
  inboxes = [...new Set(inboxes)];

  console.log(`Sampling up to ${args.perInbox} conversations per inbox across ${inboxes.length} inboxes (last ${args.days} days)...`);
  const conversations = await fetchConversationSample({
    perInbox: args.perInbox,
    days: args.days,
    inboxes,
  });
  console.log(`Got ${conversations.length} conversations. Pulling threads + triaging...`);

  const results = [];
  let i = 0;
  for (const conv of conversations) {
    i += 1;
    try {
      const turns = await fetchThread(conv.CONVERSATION_ID);
      if (turns.length === 0) continue;
      const triage = await triageOne(systemPrompt, schema, conv, turns);
      results.push({ conv, turns, ...triage });
      const flag = triage.parsed.worth_deeper_look ? "FLAG" : "ok";
      if (i % 10 === 0 || triage.parsed.worth_deeper_look) {
        console.log(`  [${i}/${conversations.length}] ${conv.INBOX_NAME.padEnd(28)} ${flag} sev=${triage.parsed.severity} ${triage.parsed.primary_criterion}`);
      }
    } catch (err) {
      console.error(`  [${i}/${conversations.length}] ${conv.CONVERSATION_ID} error: ${err.message}`);
    }
  }

  const summary = summarize(results);
  summary.promptVersion = promptVersion;

  // Write outputs
  const reportPath = resolve(repoRoot, args.out);
  mkdirSync(resolve(reportPath, ".."), { recursive: true });
  writeFileSync(reportPath, renderMarkdown({ args, conversations, results, summary }), "utf8");
  const jsonlPath = reportPath.replace(/\.md$/, ".jsonl");
  writeFileSync(jsonlPath, results.map(r => JSON.stringify({
    conversation_id: r.conv.CONVERSATION_ID,
    inbox: r.conv.INBOX_NAME,
    subject: r.conv.CONVERSATION_SUBJECT,
    minutes_to_first_reply: r.conv.MINUTES_TO_FIRST_REPLY,
    current_status: r.conv.CURRENT_STATUS,
    parsed: r.parsed,
    usage: r.usage,
  })).join("\n"), "utf8");

  console.log(`\n=== Spike summary ===`);
  console.log(`Conversations triaged: ${results.length}`);
  console.log(`Flagged: ${summary.flagged} (${(100 * summary.flagged / results.length).toFixed(1)}%)`);
  console.log(`Severity:`);
  for (const sev of [1,2,3,4,5]) console.log(`  sev ${sev}: ${summary.bySeverity[sev] ?? 0}`);
  console.log(`Criteria firing:`);
  for (const [code, n] of Object.entries(summary.byCriterion).sort((a,b) => b[1] - a[1])) {
    console.log(`  ${code}: ${n}`);
  }
  console.log(`Cost (estimated): $${summary.estCostUsd.toFixed(3)}`);
  console.log(`\nReport: ${reportPath}`);
  console.log(`JSONL:  ${jsonlPath}`);
}

try { await main(); } catch (e) { console.error(e instanceof Error ? e.stack : String(e)); process.exit(1); }
