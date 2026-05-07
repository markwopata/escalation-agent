// Tier B investigation for flagged Front conversations.
//
// Different from Slack Tier B: Front conversations are self-contained
// (thread = full context, no need for cross-channel retrieval), so we use
// a single-shot Sonnet call with structured output rather than the
// toolrunner-based loop. Cheaper, faster.
//
// Usage:
//   npm run investigate:front                    # all flagged sev 4+ without an investigation
//   npm run investigate:front -- --limit 50      # cap
//   npm run investigate:front -- --min-severity 3  # include sev 3 too
//
// Each investigation produces { decision, severity, exec_summary, rationale,
// recommended_actions } persisted to front_investigations.

import process from "node:process";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { openDatabase, nowIso } from "./lib/db.mjs";
import { loadLocalEnv } from "./lib/load-env.mjs";
import { applyRoleFix } from "./lib/front-role-fix.mjs";
import { getExecFeedbackContextText } from "./lib/exec-feedback-context.mjs";

loadLocalEnv();

const FRONT_INVESTIGATION_PROMPT_VERSION = "front-investigate-v1";
const FRONT_INVESTIGATION_MODEL = "claude-sonnet-4-6";

const FrontInvestigationSchema = z.object({
  decision: z.enum(["escalate", "monitor", "dismiss"])
    .describe("escalate = exec should see this; monitor = worth tracking; dismiss = false positive."),
  severity: z.number().int().min(1).max(5)
    .describe("Post-investigation severity. May differ from Tier A — explain in rationale if it does."),
  exec_summary: z.string().min(20).max(1500)
    .describe("One short paragraph (3-5 sentences, <1500 chars) for an exec. State the issue, who's affected, why it matters now."),
  rationale: z.string().min(40).max(5000)
    .describe("Reasoning trail behind the decision (max 5000 chars). Reference specific evidence — sender names, dates, dollar values. Acknowledge counter-signals."),
  recommended_actions: z.array(z.string()).max(5)
    .describe("Up to 5 concrete next steps for the exec — one phrase each. Empty list if dismiss."),
});

const SYSTEM_PROMPT = `You are the Tier B investigator for the EquipmentShare escalation agent, focused on Front conversations.

You receive ONE flagged Front conversation at a time (Tier A, Haiku, already decided it was worth a deeper look) and must decide whether the exec audience (CEO Jabbok, President Will, Director Mark Wopata) should see it.

Front carries customer-facing email + chat threads. Unlike Slack (internal-only), customers ARE present in the transcript. Roles in the transcript:
- CUSTOMER — external person writing to EquipmentShare
- ES_EMPLOYEE — EquipmentShare team member responding (or NOT responding)

Things to look for:
- Customer follow-ups with no reply (the strongest dead-air signal — customer chased ≥2 times, ES never answered)
- ES employees writing IN to a corporate inbox asking for help, then getting no response (internal escalation gone silent)
- Process-bouncing replies ("forward to coi@", "submit through portal") instead of solving
- Material dollar amounts, named customers (especially top accounts), legal/contract risk
- Time-sensitive requests with no resolution (deadlines, stadium events, court dates, etc.)

Things to NOT flag:
- Templated workflow notifications (off-rent confirmations, parts requests, invoice arrivals from vendor systems)
- Telematics auto-alerts (Trackunit ignition/speed/tracker-removed)
- Routine same-day customer questions that got a same-day answer
- Internal back-office archive workflows where "no reply on Front" is intentional (e.g. Fleet Sourcing escalation forwards, per known carve-outs)

Output severity rubric:
- 5: drop everything (CEO needs to know now — major customer at risk, regulator notification, exec personally cited, multi-million dollar exposure)
- 4: strong signal, exec should see in next digest (real customer-impacting friction, named dollar amounts, pattern recurrence)
- 3: worth tracking, may not warrant exec eyeballs yet (one-off, monitoring for recurrence)
- 2: borderline, lean dismiss
- 1: clearly routine, dismiss

Decision rubric:
- escalate = severity 4+ AND exec-actionable
- monitor = severity 3 OR severity 4 but already being handled visibly
- dismiss = severity 1-2 OR clearly resolved/templated

Be parsimonious. Default to dismiss when the signal is weak. The exec gets a digest from Slack AND Front; they don't need every Front conversation, only the ones that change their decisions.`;

function parseArgs(argv) {
  const args = { limit: null, minSeverity: 4 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--min-severity") args.minSeverity = Number(argv[++i]);
  }
  return args;
}

function elapsedHuman(iso) {
  if (!iso) return "?";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function renderTranscript(turns) {
  const lines = [];
  for (const t of turns) {
    const when = (t.created_at ?? "").slice(0, 19).replace("T", " ");
    const role = t.role === "customer" ? "CUSTOMER" : "ES_EMPLOYEE";
    const text = (t.text ?? "").trim().slice(0, 2000);
    lines.push(`[${when}] ${role}: ${text}`);
  }
  return lines.join("\n\n");
}

function buildUserContent({ conv, turns, tierA, exec_feedback_text }) {
  const lines = [];
  lines.push(`SOURCE: Front conversation`);
  lines.push(`Inbox: "${conv.inbox_name}"`);
  lines.push(`Subject: ${conv.subject ?? "(no subject)"}`);
  lines.push(`Status: ${conv.current_status ?? "?"}`);
  lines.push(`Created: ${conv.conversation_created_at?.slice(0, 19) ?? "?"} (${elapsedHuman(conv.conversation_created_at)} ago)`);
  if (conv.minutes_to_first_reply == null) lines.push(`Minutes to first reply: NEVER REPLIED`);
  else if (Number(conv.minutes_to_first_reply) < 0) lines.push(`First reply: ES sent first (outbound-initiated)`);
  else lines.push(`Minutes to first reply: ${Math.round(Number(conv.minutes_to_first_reply))}m`);
  lines.push(`Message counts: total=${conv.total_message_count}, inbound=${conv.inbound_message_count}, outbound=${conv.outbound_message_count}`);
  lines.push("");
  lines.push("TIER A VERDICT (Haiku):");
  lines.push(`  severity: ${tierA.severity} · primary_criterion: ${tierA.primary_criterion}`);
  lines.push(`  reason: ${tierA.reason}`);
  lines.push("");
  if (exec_feedback_text) {
    lines.push(exec_feedback_text);
    lines.push("");
  }
  lines.push("=== CONVERSATION ===");
  lines.push(renderTranscript(turns));
  lines.push("");
  lines.push(`Front URL: https://app.frontapp.com/open/${conv.conversation_id}`);
  return lines.join("\n");
}

let cachedClient = null;
function getClient() {
  if (!cachedClient) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set.");
    cachedClient = new Anthropic();
  }
  return cachedClient;
}

const INSERT_SQL = `
INSERT OR REPLACE INTO front_investigations (
  front_triage_run_id, conversation_id, inbox_id, model, prompt_version,
  decision, severity, exec_summary, rationale, recommended_actions_json,
  full_response_json, input_tokens, output_tokens,
  cache_read_input_tokens, cache_creation_input_tokens, ran_at, duration_ms
) VALUES (
  @triage_id, @cid, @inbox_id, @model, @prompt_version,
  @decision, @severity, @exec_summary, @rationale, @actions,
  @full, @in_tok, @out_tok, @cache_r, @cache_w, @ran_at, @dur
)
`;

async function investigateOne({ db, triage, conv, exec_feedback_text }) {
  const turns = db.prepare(`
    SELECT turn_index, role, author_id, created_at, text
    FROM front_messages WHERE conversation_id = ? ORDER BY turn_index
  `).all(conv.conversation_id);
  if (turns.length === 0) throw new Error("no thread turns");

  // Re-apply role fix at investigation time.
  const corrected = applyRoleFix(turns.map(t => ({ ROLE: t.role, TEXT: t.text, AUTHOR_ID: t.author_id })));
  for (let i = 0; i < turns.length; i += 1) turns[i].role = corrected[i].ROLE;

  const userContent = buildUserContent({ conv, turns, tierA: triage, exec_feedback_text });
  const client = getClient();
  const start = Date.now();
  const response = await client.messages.parse({
    model: FRONT_INVESTIGATION_MODEL,
    max_tokens: 2000,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userContent }],
    output_config: { format: zodOutputFormat(FrontInvestigationSchema) },
  });
  const dur = Date.now() - start;
  const parsed = response.parsed_output;

  db.prepare(INSERT_SQL).run({
    triage_id: triage.id,
    cid: conv.conversation_id,
    inbox_id: conv.inbox_id,
    model: response.model ?? FRONT_INVESTIGATION_MODEL,
    prompt_version: FRONT_INVESTIGATION_PROMPT_VERSION,
    decision: parsed.decision,
    severity: parsed.severity,
    exec_summary: parsed.exec_summary,
    rationale: parsed.rationale,
    actions: JSON.stringify(parsed.recommended_actions ?? []),
    full: JSON.stringify(parsed),
    in_tok: response.usage?.input_tokens ?? null,
    out_tok: response.usage?.output_tokens ?? null,
    cache_r: response.usage?.cache_read_input_tokens ?? null,
    cache_w: response.usage?.cache_creation_input_tokens ?? null,
    ran_at: nowIso(),
    dur,
  });

  return parsed;
}

async function main() {
  const args = parseArgs(process.argv);
  const db = openDatabase();
  const exec_feedback_text = getExecFeedbackContextText(db);

  const pending = db.prepare(`
    SELECT t.id, t.conversation_id, t.inbox_id, t.severity, t.primary_criterion, t.reason, t.criteria_matched_json
    FROM front_triage_runs t
    LEFT JOIN front_investigations i
      ON i.front_triage_run_id = t.id AND i.prompt_version = ?
    WHERE t.worth_deeper_look = 1
      AND t.severity >= ?
      AND i.id IS NULL
    ORDER BY t.severity DESC, t.ran_at DESC
    ${args.limit ? `LIMIT ${Number(args.limit)}` : ""}
  `).all(FRONT_INVESTIGATION_PROMPT_VERSION, args.minSeverity);
  console.log(`Pending: ${pending.length} flagged Front conversations (sev >= ${args.minSeverity}) without ${FRONT_INVESTIGATION_PROMPT_VERSION} run.`);
  if (pending.length === 0) return;

  let ok = 0, errors = 0;
  let escalateCount = 0, monitorCount = 0, dismissCount = 0;
  for (const t of pending) {
    const conv = db.prepare(`SELECT * FROM front_conversations WHERE conversation_id = ?`).get(t.conversation_id);
    if (!conv) { errors += 1; continue; }
    try {
      const r = await investigateOne({ db, triage: t, conv, exec_feedback_text });
      ok += 1;
      if (r.decision === "escalate") escalateCount += 1;
      else if (r.decision === "monitor") monitorCount += 1;
      else dismissCount += 1;
      console.log(`[${ok}/${pending.length}] ${conv.conversation_id} → ${r.decision.toUpperCase()} sev=${r.severity}`);
      console.log(`  ${r.exec_summary.slice(0, 220)}`);
    } catch (err) {
      errors += 1;
      console.error(`  ${t.conversation_id} error: ${err.message}`);
    }
  }
  console.log(`\nDone. ${ok} ok, ${errors} errors. ${escalateCount} escalate / ${monitorCount} monitor / ${dismissCount} dismiss.`);
}

await main();
