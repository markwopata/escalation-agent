// Tier A batch triage for Front conversations.
//
// Mirrors triage-batch.mjs (Slack) — same Haiku model, same prompt, same
// criteria — but the unit of work is a Front CONVERSATION (with full
// thread) instead of a single Slack message.
//
// Usage:
//   node scripts/triage-front-batch.mjs submit                # submit all pending
//   node scripts/triage-front-batch.mjs poll                  # poll + persist
//   node scripts/triage-front-batch.mjs list                  # show batch jobs
//   node scripts/triage-front-batch.mjs submit --cap 250      # custom cost cap
//   node scripts/triage-front-batch.mjs submit --force-over-cap   # override cap
//   node scripts/triage-front-batch.mjs submit --inbox-kind customer-facing  # subset
//
// Skips inboxes with triage_enabled=0 (e.g. workflow-bot inboxes).

import process from "node:process";
import { openDatabase, nowIso } from "./lib/db.mjs";
import { TRIAGE_MODEL, buildTriageResultSchema, getTriagePromptVersion } from "./lib/triage.mjs";
import { buildSystemPrompt, loadActiveCriterionCodes } from "./lib/triage-prompt.mjs";
import {
  buildBatchRequest, submitTriageBatch, getBatchStatus,
  iterateBatchResults, extractTriageResultFromBatchRow,
} from "./lib/batch-triage.mjs";
import { getExecFeedbackContextText } from "./lib/exec-feedback-context.mjs";
import { applyRoleFix } from "./lib/front-role-fix.mjs";
import { estimateBudget, enforceCap, formatEstimate } from "./lib/cost-cap.mjs";

function parseArgs(argv) {
  // Chunk size: V8 JSON.stringify can't handle ~30K+ batch requests in one go
  // (each carries the cached system prompt + per-message user content).
  // 8000 keeps the JSON body comfortably under V8's max string length.
  const args = { mode: argv[2] ?? "submit", cap: 250, forceOverCap: false, inboxKind: null, limit: null, chunkSize: 8000 };
  for (let i = 3; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--cap") args.cap = Number(argv[++i]);
    else if (a === "--force-over-cap") args.forceOverCap = true;
    else if (a === "--inbox-kind") args.inboxKind = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--chunk-size") args.chunkSize = Number(argv[++i]);
  }
  return args;
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

function describeInbox(name) {
  if (/ - Sales$/i.test(name)) return "branch-level Sales — local rep handling customer rentals/sales for one location";
  if (/ - Service$/i.test(name)) return "branch-level Service — local mechanics/service handling repairs and maintenance for one location";
  if (/ - Parts$/i.test(name)) return "branch-level Parts — local parts desk fulfilling parts requests for one location";
  return name;
}

function renderTranscript(turns) {
  const lines = [];
  for (const t of turns) {
    const when = (t.created_at ?? "").slice(0, 19).replace("T", " ");
    const role = t.role === "customer" ? "CUSTOMER" : "ES_EMPLOYEE";
    const text = (t.text ?? "").trim().slice(0, 1200);
    lines.push(`[${when}] ${role}: ${text}`);
  }
  return lines.join("\n\n");
}

function buildFrontUserContent({ conv, turns, exec_feedback_text }) {
  const lines = [];
  lines.push(`SOURCE: Front (customer-facing email/chat inbox).`);
  lines.push(`Inbox: "${conv.inbox_name}" — ${describeInbox(conv.inbox_name)}`);
  lines.push(`Subject: ${conv.subject ?? "(no subject)"}`);
  lines.push(`Status: ${conv.current_status ?? "?"}`);
  lines.push(`Created: ${conv.conversation_created_at?.slice(0,19) ?? "?"} (${elapsedHuman(conv.conversation_created_at)} ago)`);
  if (conv.minutes_to_first_reply != null) {
    const m = Number(conv.minutes_to_first_reply);
    if (m < 0) lines.push(`First reply: ES sent first (outbound-initiated; ${Math.abs(Math.round(m))}m before any inbound).`);
    else lines.push(`Minutes to first reply: ${Math.round(m)}m.`);
  } else {
    lines.push(`Minutes to first reply: NEVER REPLIED.`);
  }
  lines.push(`Message counts: total=${conv.total_message_count}, inbound=${conv.inbound_message_count}, outbound=${conv.outbound_message_count}.`);
  lines.push("");
  lines.push("FRONT-SPECIFIC INTERPRETATION GUIDE");
  lines.push("- Roles in the transcript: CUSTOMER (external) or ES_EMPLOYEE (EquipmentShare team).");
  lines.push("- Unlike Slack, customer voice IS direct here. 'sales_relaying_customer_pain' becomes 'customer expressing pain themselves' — same signal, more direct.");
  lines.push("");
  lines.push("WORKFLOW NOTIFICATIONS vs HUMAN MESSAGES");
  lines.push("Many Front conversations are SYSTEM-GENERATED workflow notifications, not human conversations. NEVER flag these regardless of reply status:");
  lines.push("- Templated subjects like 'Rentals #X have been off-rented', 'New Parts Request from {Branch}', 'Customer requesting service' (when body is just a structured form), 'INVOICE_X_Y', vendor invoice arrivals.");
  lines.push("- Telematics alerts: 'Ignition On Alert', 'Tracker Removed Alert', 'Speed Alert'.");
  lines.push("- Auto-confirmations or system bounce notices.");
  lines.push("- AUTOMATED QUOTE EMAILS from EquipmentShare's quotes tool — recognizable by URLs containing 'u51874413.ct.sendgrid.net' (this is the SendGrid tracker for the quotes tool's auto-mailer). Subject line typically 'Quote # has been approved' or similar. Body is structured: customer name, location, delivery type, quote number with the SendGrid tracking URL. These are SYSTEM-TO-SYSTEM notifications routed to branch sales inboxes. ");
  lines.push("These are system-to-system. Mark as 'none' even if no reply for days.");
  lines.push("");
  lines.push("AUTO-QUOTE EMAILS — SPECIFIC RULE");
  lines.push("If the conversation has ONLY ONE message AND that message contains 'u51874413.ct.sendgrid.net' (the quotes-tool SendGrid URL), it is an automated quote email standing alone. Mark as 'none' regardless of dead-air time. The quotes tool emails branch inboxes automatically when a quote is approved; archive-without-reply IS the normal workflow.");
  lines.push("");
  lines.push("HOWEVER: if a HUMAN follows up on the quote email (a second inbound message from the customer or rep asking 'any update', 'when can we expect delivery', etc.) and THAT goes unanswered, that IS escalatable as help_channel_dead_air. The signal is the human follow-up being ignored, not the original automation cycle.");
  lines.push("");
  lines.push("SERVICE-INTAKE FORMS — SPECIFIC RULE");
  lines.push("If the conversation has ONLY ONE message AND that message has the structured Front service-intake form template — recognizable by containing BOTH 'Customer Information:' and 'Asset Information:' headers (often with 'T3 Lookups:' too, and sometimes a 'To unsubscribe from this group' footer) — it is the standard automated web-form submission landing in a branch service inbox. Mark as 'none' regardless of dead-air time.");
  lines.push("");
  lines.push("This pattern looks personal because it has a customer name, company, asset details, and contact info — but the customer didn't write a personal message; they submitted a web form. Many of these are routed offline (phone callback, T3 work order created elsewhere) without a Front reply. Archive-without-reply on the standalone form IS the normal workflow.");
  lines.push("");
  lines.push("HOWEVER: if a HUMAN follows up on the form submission (the customer emails again asking for status, or an internal employee replies/forwards asking who owns this), THEN dead-air on the follow-up IS escalatable. The signal is the follow-up being ignored, not the original form submission.");
  lines.push("");
  lines.push("SERVICE-INBOX HANDOFFS — SPECIFIC RULE (UPDATED)");
  lines.push("If the conversation is in a SERVICE inbox (inbox name contains 'Service', e.g. 'Tampa Service', 'El Paso Service', 'Memphis Service', 'Cibolo TX Rental Yard - Service'), apply BOTH of these checks:");
  lines.push("");
  lines.push("(a) ZERO CUSTOMER TURNS — if EVERY turn in the conversation is role='es_employee' (no customer message ever appears, regardless of total turn count), mark as 'none'. These are internal handoffs — TAMs emailing service desks to dispatch techs, sales coordinators forwarding requests, automation forwards from customersupport@equipmentshare.com. The 'From: EquipmentShare' label means it's an internal forward, not a customer reaching out. Service inboxes coordinate dispatch among ES employees; without a customer turn, there is no customer voice and nothing for an exec to escalate.");
  lines.push("");
  lines.push("(b) 1-TURN — even if the single turn is from a customer, mark as 'none'. A standalone customer service request landing in a service inbox is the normal intake; resolution often happens offline (phone callback, T3 work order). Without a follow-up showing the customer was ignored, this is workflow.");
  lines.push("");
  lines.push("REQUIRED FOR ESCALATION: at least one CUSTOMER turn AND at least one further turn after it (either a customer follow-up that went unanswered, or an ES_EMPLOYEE non-resolution that the customer pushed back on). The follow-up is the signal that workflow broke down. Without it, you're flagging the workflow itself.");
  lines.push("");
  lines.push("REAL DEAD-AIR (FLAG WITH HIGH PRECISION)");
  lines.push("A HUMAN (customer or internal employee) wrote asking a question or reporting an issue, and got no resolution:");
  lines.push("- 'help_channel_dead_air' applies when a HUMAN customer or HUMAN employee writes and gets no reply, especially if they followed up. Customer follow-ups (>=2 inbound from same customer) are the strongest signal.");
  lines.push("- 'corporate_obstructing_field' applies when ES_EMPLOYEE responses are process-bouncing ('forward to coi@', 'submit through portal', 'not our team') instead of solving.");
  lines.push("- For inbound-only conversations: ONLY flag if the message is human-authored. If the body reads like a templated workflow email (structured, no greeting, no question, just data), do NOT flag.");
  lines.push("");
  if (exec_feedback_text) {
    lines.push(exec_feedback_text);
    lines.push("");
  }
  lines.push("=== CONVERSATION TO TRIAGE ===");
  lines.push(renderTranscript(turns));
  return lines.join("\n");
}

const INSERT_FRONT_TRIAGE = `
INSERT OR REPLACE INTO front_triage_runs (
  conversation_id, inbox_id, model, prompt_version,
  worth_deeper_look, severity, primary_criterion, criteria_matched_json, reason,
  full_response_json,
  input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
  ran_at, duration_ms
) VALUES (
  @cid, @inbox_id, @model, @prompt_version,
  @worth, @sev, @primary, @matched, @reason, @full,
  @in_tok, @out_tok, @cache_r, @cache_w, @ran_at, @dur
)
`;

function persistTriage(db, conv, parsed, meta, promptVersion) {
  db.prepare(INSERT_FRONT_TRIAGE).run({
    cid: conv.conversation_id,
    inbox_id: conv.inbox_id,
    model: meta.model,
    prompt_version: promptVersion,
    worth: parsed.worth_deeper_look ? 1 : 0,
    sev: parsed.severity,
    primary: parsed.primary_criterion,
    matched: JSON.stringify(parsed.criteria_matched ?? []),
    reason: parsed.reason,
    full: JSON.stringify(parsed),
    in_tok: meta.usage?.input_tokens ?? null,
    out_tok: meta.usage?.output_tokens ?? null,
    cache_r: meta.usage?.cache_read_input_tokens ?? null,
    cache_w: meta.usage?.cache_creation_input_tokens ?? null,
    ran_at: nowIso(),
    dur: null,
  });
}

async function submitMode(args) {
  const db = openDatabase();
  const promptVersion = getTriagePromptVersion(db);

  // Guard: refuse to submit while a prior batch at the same prompt_version
  // is still in flight. Hourly ticks must not re-submit pending conversations
  // before the prior batch has persisted (we burned $17 on a Front duplicate
  // via this race once).
  const inFlight = db.prepare(`
    SELECT batch_id FROM batch_jobs
    WHERE job_type = 'triage_front' AND status = 'submitted' AND prompt_version = ?
    ORDER BY id DESC LIMIT 1
  `).get(promptVersion);
  if (inFlight) {
    console.log(`Skipping submit — Front batch ${inFlight.batch_id} already in flight at this prompt version.`);
    return;
  }

  const { prompt: systemPrompt } = buildSystemPrompt(db);
  const schema = buildTriageResultSchema(loadActiveCriterionCodes(db));
  const exec_feedback_text = getExecFeedbackContextText(db);

  // Pull pending conversations: those without a triage run for the current
  // prompt_version, in inboxes with triage_enabled=1.
  const kindFilter = args.inboxKind ? `AND ib.inbox_kind = '${args.inboxKind}'` : "";
  const pending = db.prepare(`
    SELECT c.* FROM front_conversations c
    JOIN front_inboxes ib ON ib.inbox_id = c.inbox_id
    LEFT JOIN front_triage_runs t
      ON t.conversation_id = c.conversation_id AND t.prompt_version = ?
    WHERE ib.triage_enabled = 1
      AND t.id IS NULL
      ${kindFilter}
    ORDER BY c.conversation_created_at DESC
    ${args.limit ? `LIMIT ${Number(args.limit)}` : ""}
  `).all(promptVersion);
  console.log(`Pending: ${pending.length} Front conversations (prompt ${promptVersion}).`);
  if (pending.length === 0) return;

  // Pre-flight cost estimate + cap enforcement.
  const estimate = estimateBudget({ items: [
    { model: TRIAGE_MODEL, mode: "batch", kind: "tier_a_front", count: pending.length },
  ]});
  console.log(formatEstimate(estimate, args.cap));
  if (!args.forceOverCap) {
    try { enforceCap({ capUsd: args.cap, estimate }); }
    catch (err) { console.error(err.message); process.exit(2); }
  }

  // Build batch requests.
  const requests = [];
  const customIdMap = {};
  for (const conv of pending) {
    const turns = db.prepare(`
      SELECT turn_index, role, author_id, created_at, text
      FROM front_messages WHERE conversation_id = ?
      ORDER BY turn_index
    `).all(conv.conversation_id);
    if (turns.length === 0) continue; // skip conversations with no thread (shouldn't happen post-ingest)

    // Re-apply role fix at triage time (defense-in-depth in case ingestion
    // ran with an older fix).
    const corrected = applyRoleFix(turns.map(t => ({ ROLE: t.role, TEXT: t.text, AUTHOR_ID: t.author_id })));
    for (let i = 0; i < turns.length; i += 1) turns[i].role = corrected[i].ROLE;

    const userContent = buildFrontUserContent({ conv, turns, exec_feedback_text });
    const customId = `front_${conv.conversation_id}`;
    customIdMap[customId] = { conversation_id: conv.conversation_id, inbox_id: conv.inbox_id };
    requests.push(buildBatchRequest(customId, systemPrompt, userContent, TRIAGE_MODEL, schema));
  }
  if (requests.length === 0) return;

  // Chunk into multiple Anthropic batches if total exceeds chunkSize.
  // V8's JSON.stringify cap (~512MB) breaks at ~30K requests; chunkSize=8000
  // keeps each batch comfortably under that.
  const chunkSize = args.chunkSize;
  const numChunks = Math.ceil(requests.length / chunkSize);
  console.log(`Submitting ${requests.length} requests across ${numChunks} batch(es) of up to ${chunkSize}...`);

  const insert = db.prepare(`
    INSERT INTO batch_jobs (
      batch_id, job_type, prompt_version, request_count, status, submitted_at, custom_id_map_json
    ) VALUES (?, 'triage_front', ?, ?, 'submitted', ?, ?)
  `);
  for (let i = 0; i < numChunks; i += 1) {
    const slice = requests.slice(i * chunkSize, (i + 1) * chunkSize);
    const sliceMap = {};
    for (const req of slice) sliceMap[req.custom_id] = customIdMap[req.custom_id];
    const batch = await submitTriageBatch(slice);
    insert.run(batch.id, promptVersion, slice.length, nowIso(), JSON.stringify(sliceMap));
    console.log(`  [${i + 1}/${numChunks}] Submitted ${batch.id} with ${slice.length} requests · status=${batch.processing_status}`);
  }
  console.log(`Poll later: npm run triage:front-batch -- poll`);
}

async function pollMode() {
  const db = openDatabase();
  const pending = db.prepare(`SELECT * FROM batch_jobs WHERE status = 'submitted' AND job_type = 'triage_front'`).all();
  if (pending.length === 0) {
    console.log("No pending Front batch jobs.");
    return;
  }
  for (const job of pending) {
    const status = await getBatchStatus(job.batch_id);
    console.log(`Batch ${job.batch_id}: ${status.processing_status}, succeeded=${status.request_counts?.succeeded}, errored=${status.request_counts?.errored}`);
    if (status.processing_status !== "ended") continue;

    const customIdMap = JSON.parse(job.custom_id_map_json);
    let ok = 0, errors = 0;
    // We need conversation rows to persist (need inbox_id too). Build a quick lookup.
    const convLookup = new Map();
    for await (const row of iterateBatchResults(job.batch_id)) {
      const target = customIdMap[row.custom_id];
      if (!target) { errors += 1; continue; }
      const result = extractTriageResultFromBatchRow(row);
      if (result.error) {
        console.error(`  Error on ${row.custom_id}: ${result.error}`);
        errors += 1;
        continue;
      }
      let conv = convLookup.get(target.conversation_id);
      if (!conv) {
        conv = db.prepare(`SELECT conversation_id, inbox_id FROM front_conversations WHERE conversation_id = ?`).get(target.conversation_id);
        if (conv) convLookup.set(target.conversation_id, conv);
      }
      if (!conv) { errors += 1; continue; }
      persistTriage(db, conv, result.parsed, { model: result.model, usage: result.usage }, job.prompt_version);
      ok += 1;
    }
    db.prepare(`UPDATE batch_jobs SET status = 'persisted', ended_at = ?, persisted_at = ? WHERE id = ?`)
      .run(nowIso(), nowIso(), job.id);
    console.log(`  Persisted ${ok} results, ${errors} errors. Batch ${job.batch_id} marked persisted.`);
  }
}

async function listMode() {
  const db = openDatabase();
  const rows = db.prepare(`SELECT * FROM batch_jobs WHERE job_type = 'triage_front' ORDER BY id DESC LIMIT 20`).all();
  for (const r of rows) console.log(`#${r.id} batch=${r.batch_id} status=${r.status} count=${r.request_count} submitted=${r.submitted_at}`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.mode === "submit") await submitMode(args);
  else if (args.mode === "poll") await pollMode();
  else if (args.mode === "list") await listMode();
  else { console.error(`Unknown mode: ${args.mode}`); process.exit(1); }
}

await main();
