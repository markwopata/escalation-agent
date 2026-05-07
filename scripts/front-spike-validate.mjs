// Validation pass for the front-spike's "NEVER replied" flags.
//
// For each flagged conversation, we re-query the warehouse (which has
// refreshed since the spike ran) and check whether:
//   - The customer followed up (>=2 inbound messages) → CUSTOMER_FOLLOWED_UP
//     This is the strongest "true dead air" signal — customer had to chase.
//   - An es_employee message exists by now → EVENTUALLY_REPLIED
//     The flag was correct in the moment but the issue was resolved on Front.
//     We bucket these separately so we can decide policy on delayed-reply.
//   - Status went archived without any ES reply → OFFLINE_RESOLVED_QUESTIONABLE
//     Possibly resolved by phone/email outside Front. Could be a true false
//     positive, or could be the customer giving up.
//   - Still no reply, status still open → TRUE_DEAD_AIR
//     Worst case — message is rotting in Front right now.
//
// Output: a CSV-like table to stdout + JSONL to disk for follow-up.

import process from "node:process";
import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadLocalEnv, repoRoot } from "./lib/load-env.mjs";
import { executeSqlThroughFrostyWithWarehouse } from "./lib/frosty-client.mjs";
import { applyRoleFix } from "./lib/front-role-fix.mjs";

loadLocalEnv();

function parseArgs(argv) {
  const args = { input: "reports/front-spike-expanded.jsonl", out: "reports/front-spike-validate.jsonl", limit: null, severity: null, criterion: "help_channel_dead_air", neverOnly: true };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--input") args.input = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--severity") args.severity = Number(argv[++i]);
    else if (a === "--criterion") args.criterion = argv[++i];
    else if (a === "--include-replied") args.neverOnly = false;
  }
  return args;
}

async function fetchCurrentThread(conversationId) {
  // Pull TEXT and AUTHOR_ID too so applyRoleFix can correct mislabeled rows.
  const sql = `WITH t AS (
    SELECT MIN(TURN_INDEX) AS TURN_INDEX, ANY_VALUE(ROLE) AS ROLE,
           ANY_VALUE(AUTHOR_ID) AS AUTHOR_ID,
           ANY_VALUE(CREATED_AT) AS CREATED_AT,
           ANY_VALUE(TEXT) AS TEXT, MESSAGE_ID
    FROM PEOPLE_ANALYTICS.FRONT_ESCALATION.FRONT_ESCALATION_THREAD_FLAT
    WHERE CONVERSATION_ID = '${conversationId.replace(/'/g, "''")}'
    GROUP BY MESSAGE_ID
  )
  SELECT TURN_INDEX, ROLE, AUTHOR_ID, CREATED_AT, TEXT FROM t`;
  const r = await executeSqlThroughFrostyWithWarehouse(sql.trim());
  if (!r.success) throw new Error(`thread query failed for ${conversationId}: ${r.error}`);
  return applyRoleFix(r.data);
}

async function fetchCurrentSummary(conversationId) {
  const sql = `WITH s AS (
    SELECT CONVERSATION_ID, CURRENT_STATUS, MINUTES_TO_FIRST_REPLY,
           TOTAL_MESSAGE_COUNT, INBOUND_MESSAGE_COUNT, OUTBOUND_MESSAGE_COUNT,
           LAST_MESSAGE_AT
    FROM PEOPLE_ANALYTICS.FRONT_ESCALATION.FRONT_ESCALATION_CONVERSATION_SUMMARY
    WHERE CONVERSATION_ID = '${conversationId.replace(/'/g, "''")}'
  )
  SELECT * FROM s`;
  const r = await executeSqlThroughFrostyWithWarehouse(sql.trim());
  if (!r.success) throw new Error(`summary query failed for ${conversationId}: ${r.error}`);
  return r.data[0] ?? null;
}

async function fetchStatusHistory(conversationId) {
  const sql = `WITH h AS (
    SELECT STATUS, UPDATED_AT, SOURCE_TYPE
    FROM PEOPLE_ANALYTICS.FRONT_ESCALATION.FRONT_ESCALATION_CONVERSATION_STATUS_HISTORY
    WHERE CONVERSATION_ID = '${conversationId.replace(/'/g, "''")}'
  )
  SELECT * FROM h`;
  const r = await executeSqlThroughFrostyWithWarehouse(sql.trim());
  if (!r.success) return [];
  return r.data;
}

function categorize({ summary, turns, history }) {
  if (!summary) return { category: "UNKNOWN", note: "no summary row" };
  const inbound = turns.filter(t => t.ROLE === "customer").length;
  const outbound = turns.filter(t => t.ROLE === "es_employee").length;
  const status = summary.CURRENT_STATUS;

  // Pure-internal threads (no customer turns at all) — ES employee wrote IN
  // to this inbox to escalate something on a customer's behalf, or to ask
  // for help. These are 'sales_relaying_customer_pain' style internal
  // escalations. Different category from customer-driven dead air.
  if (inbound === 0 && outbound >= 1) {
    if (outbound === 1) {
      return { category: "INTERNAL_ESCALATION_NO_REPLY", inbound, outbound, status };
    }
    return { category: "INTERNAL_ESCALATION_REPLIED", inbound, outbound, status };
  }

  // From here on, customer is in the thread.
  const customerFollowedUp = inbound >= 2;

  if (outbound >= 1) {
    const cat = customerFollowedUp ? "CUSTOMER_FOLLOWED_UP_THEN_REPLIED" : "EVENTUALLY_REPLIED";
    return { category: cat, inbound, outbound, status, minutes_to_first_reply: summary.MINUTES_TO_FIRST_REPLY };
  }

  // Outbound = 0
  if (customerFollowedUp) {
    return { category: "CUSTOMER_FOLLOWED_UP_NO_REPLY", inbound, outbound, status, minutes_to_first_reply: null };
  }

  // Single inbound, no reply
  if (status === "archive" || status === "archived") {
    return { category: "OFFLINE_RESOLVED_QUESTIONABLE", inbound, outbound, status, note: "archived without any ES reply — possibly resolved offline or abandoned" };
  }
  return { category: "TRUE_DEAD_AIR", inbound, outbound, status };
}

async function main() {
  const args = parseArgs(process.argv);
  const lines = readFileSync(args.input, "utf8").trim().split("\n").map(l => JSON.parse(l));
  let candidates = lines.filter(l => l.parsed.worth_deeper_look);
  if (args.criterion) candidates = candidates.filter(l => l.parsed.primary_criterion === args.criterion);
  if (args.severity) candidates = candidates.filter(l => l.parsed.severity === args.severity);
  if (args.neverOnly) candidates = candidates.filter(l => l.minutes_to_first_reply == null);
  if (args.limit) candidates = candidates.slice(0, args.limit);
  console.log(`Validating ${candidates.length} flagged conversations (criterion=${args.criterion}, severity=${args.severity ?? "any"}, neverOnly=${args.neverOnly}).`);

  const results = [];
  let i = 0;
  for (const c of candidates) {
    i += 1;
    try {
      const turns = await fetchCurrentThread(c.conversation_id);
      const summary = await fetchCurrentSummary(c.conversation_id);
      const history = await fetchStatusHistory(c.conversation_id);
      const verdict = categorize({ summary, turns, history });
      results.push({ ...c, verdict });
      if (i % 10 === 0 || verdict.category !== "TRUE_DEAD_AIR") {
        console.log(`  [${i}/${candidates.length}] ${c.conversation_id} sev=${c.parsed.severity} ${verdict.category} (in=${verdict.inbound} out=${verdict.outbound} status=${verdict.status})`);
      }
    } catch (err) {
      console.error(`  [${i}/${candidates.length}] ${c.conversation_id} error: ${err.message}`);
      results.push({ ...c, verdict: { category: "ERROR", note: err.message } });
    }
  }

  // Tally
  const tally = {};
  for (const r of results) tally[r.verdict.category] = (tally[r.verdict.category] ?? 0) + 1;
  console.log("\n=== Verdict tally ===");
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(38)} ${v} (${(100 * v / results.length).toFixed(0)}%)`);
  }

  // Write JSONL
  const outPath = resolve(repoRoot, args.out);
  writeFileSync(outPath, results.map(r => JSON.stringify(r)).join("\n"), "utf8");
  console.log(`\nWritten: ${outPath}`);
}

try { await main(); } catch (e) { console.error(e instanceof Error ? e.stack : String(e)); process.exit(1); }
