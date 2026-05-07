// Tier B investigation: Sonnet picks up flagged Tier A items, gets full
// context + tool access (DB lookups), and decides escalate / monitor / dismiss.
//
// Tools wrap the pure DB helpers in scripts/lib/investigation-tools.mjs and
// are exposed to Sonnet via the SDK's beta tool runner with Zod schemas.
// The system prompt below is large by design so it caches on Sonnet 4.6
// (>1024-token minimum).

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { loadLocalEnv } from "./load-env.mjs";
import {
  fetchMessage,
  fetchThreadReplies,
  searchMessages,
  getChannelHistory,
  lookupEmployee,
  findRelatedTriageFlags,
  countMessagesByAuthor,
} from "./investigation-tools.mjs";
import { getExecFeedbackContextText } from "./exec-feedback-context.mjs";

loadLocalEnv();

export const INVESTIGATION_PROMPT_VERSION = "investigate-v3-grounding";
export const INVESTIGATION_MODEL_HARD = "claude-sonnet-4-6"; // for cross-channel, systemic, high-sev
export const INVESTIGATION_MODEL_EASY = "claude-haiku-4-5";  // for routine single-channel cases
export const INVESTIGATION_MODEL = INVESTIGATION_MODEL_HARD; // backward compat — default to hard

// Routes a flagged triage run to the right investigation tier.
// Hard tier (Sonnet) when ANY of:
//   - severity >= 4
//   - primary_criterion is systemic_branch_pattern (needs cross-channel reasoning)
//   - multiple criteria_matched (likely a layered case)
//   - author has 2+ flagged messages in the last 30 days (likely a cluster)
// Otherwise: easy tier (Haiku 4.5 with tools), ~3x cheaper.
export function pickInvestigationTier(triageRun, db) {
  if ((triageRun.severity ?? 0) >= 4) return INVESTIGATION_MODEL_HARD;
  if (triageRun.primary_criterion === "systemic_branch_pattern") return INVESTIGATION_MODEL_HARD;
  let matched = [];
  try { matched = JSON.parse(triageRun.criteria_matched_json ?? "[]"); } catch {}
  if (matched.length > 1) return INVESTIGATION_MODEL_HARD;
  if (db && triageRun.slack_channel_id && triageRun.slack_ts) {
    const message = db.prepare(`SELECT author_slack_user_id, message_posted_at FROM messages WHERE slack_channel_id = ? AND slack_ts = ?`)
      .get(triageRun.slack_channel_id, triageRun.slack_ts);
    if (message?.author_slack_user_id && message.message_posted_at) {
      const sinceIso = new Date(new Date(message.message_posted_at).getTime() - 30 * 86400000).toISOString();
      const otherFlags = db.prepare(`
        SELECT COUNT(*) AS n FROM triage_runs t
        JOIN messages m ON m.slack_channel_id = t.slack_channel_id AND m.slack_ts = t.slack_ts
        WHERE m.author_slack_user_id = ?
          AND t.worth_deeper_look = 1
          AND m.message_posted_at >= ?
          AND m.slack_ts != ?
      `).get(message.author_slack_user_id, sinceIso, triageRun.slack_ts);
      if ((otherFlags?.n ?? 0) >= 2) return INVESTIGATION_MODEL_HARD;
    }
  }
  return INVESTIGATION_MODEL_EASY;
}

export const InvestigationOutputSchema = z.object({
  decision: z.enum(["escalate", "monitor", "dismiss"])
    .describe("escalate = exec should see this; monitor = worth tracking but not yet exec-worthy; dismiss = false positive."),
  severity: z.number().int().min(1).max(5)
    .describe("Post-investigation severity. May differ from Tier A — explain in rationale if it does."),
  exec_summary: z.string().min(20).max(1500)
    .describe("One short paragraph (target ~3-5 sentences, <1500 chars) in plain English an exec can read in <30 seconds. State the issue, who is affected, and why it matters now. No fluff."),
  rationale: z.string().min(40).max(5000)
    .describe("The reasoning trail behind the decision (max 5000 chars). Reference specific evidence you pulled (channel names, dates, employee titles). Acknowledge counter-signals."),
  evidence_refs: z.object({
    channel_ids: z.array(z.string()).default([]),
    message_ts: z.array(z.string()).default([]),
    employee_ids: z.array(z.string()).default([]),
  }).describe("Concrete pointers into the data. Helps the Tier C / human auditor verify."),
  recommended_actions: z.array(z.string()).max(5)
    .describe("Up to 5 concrete next-step suggestions for the exec — one phrase each, like 'ask Susan if Vantage was notified about the panel delay' or 'run a 30-day count of customers contacted via Google Ads but not assigned a TAM'. Empty list if dismiss."),
});

const SYSTEM_PROMPT = `You are the Tier B investigator inside the EquipmentShare escalation agent. The Tier A triage layer (cheap, fast) has already flagged a Slack message as worth a deeper look. Your job is to decide what to do about it.

You have three possible decisions:
- escalate: An EquipmentShare top-three executive (the audience) should see this. You are confident the signal is real, the impact is meaningful, and an exec is a useful intervention point.
- monitor: There is real signal but either (a) the impact isn't yet clearly exec-level, (b) you'd want to see the thread / pattern develop more before bothering the exec, or (c) it's a known issue that doesn't need exec eyes today. Persist for trend tracking; don't surface.
- dismiss: Tier A was wrong. The flag is a false positive on closer inspection. Be honest about this — calibration is more useful than coverage.

Default to monitor for borderline cases. Escalations need to feel earned. The exec audience has a finite tolerance for items that turn out to be routine; every false escalation costs trust in the agent.

ABOUT THE COMPANY (recap)

EquipmentShare is a private US construction-equipment rental company headquartered in Columbia, Missouri. There is a corporate function (HQ teams: fleet, accounting, supply chain, IT, product, customer support, etc.) and a much larger field organization (regional yards, rental locations, onsite jobsite teams, sales/account managers, drivers, mechanics). Slack is internal only — customers communicate via Front, which is a separate ingestion path. Therefore a "customer voice" on Slack is always secondhand, surfaced by a sales/account/field employee.

The seven Tier A criteria, restated for context:
1. corporate_obstructing_field — corporate dismissive/obstructive when field is asking for help
2. sales_relaying_customer_pain — sales/account manager / field employee surfaces a customer issue secondhand
3. persistent_it_issue — tooling friction that recurs or affects many people
4. earnings_impacting_decision — operational decision in Slack with financial consequences
5. systemic_branch_pattern — same issue surfacing across multiple branches / markets / regions
6. help_channel_dead_air — request in a help-* channel that goes unanswered
7. ceo_fixable_friction — small, specific, fixable friction the CEO would want fixed if they saw it

YOUR TOOLS

You have read-only access to the local database via these tools (all return JSON):

- fetch_message: Get full record + author org context for a given (channel_id, slack_ts).
- fetch_thread_replies: Get the full thread (parent + replies) for a given thread_ts. NOTE: at the prototype stage we may have ingested only top-level channel messages — if a thread looks empty, that's an ingestion gap, not necessarily silence.
- search_messages: Substring search across all stored messages. Use sparingly — pick distinctive phrases. Use this to test whether a pattern is single-occurrence or repeated.
- get_channel_history: Pull more recent messages from a channel before/after a given time. Useful when the triage'd message references "another" or "again" — go look.
- lookup_employee: Pull an employee record by slack_user_id, employee_id, or full name. Use when the message references someone by name and you want to know if they're corp/field, what their title is, etc.
- find_related_triage_flags: Find other triage runs that match a given criterion. THIS is how you confirm systemic patterns. If criterion is sales_relaying_customer_pain and 5 different authors flagged similar issues last week, that's a real pattern.
- count_messages_by_author: How active is this author in Slack overall (since X)? A first-week new hire flagging an issue is more notable than a long-tenured habitual poster.

Use the tools. Tier A had to be cheap; you don't. A typical investigation should pull 2-5 tool calls before deciding. If you decide based only on the prompt context, you're underusing the tier.

INVESTIGATION CHECKLIST

For every flagged item, work through these:

1. Read the message and its immediate thread (fetch_thread_replies). Was it answered? By whom (corp / field, role)? Was the answer good?
2. Confirm the author's identity if Tier A was uncertain (lookup_employee). Tenure matters — a 0.2-year GM noticing something is more credible than habitual venting from a long-tenured complainer.
3. Test for systemic-ness. If Tier A flagged systemic_branch_pattern OR if the author used words like "again" / "another" / "every yard", run search_messages or find_related_triage_flags to see whether this is one-off or part of a pattern. If you find 2+ similar instances, surface them as evidence.
4. Test for recency / urgency. A delivery slip 3 weeks before a major load-in is exec-worthy; the same slip 3 months out is monitor.
5. Consider counter-signals. Is the thread already well-handled? Did corporate respond promptly with a real answer? Has someone senior already engaged? If so, lean toward dismiss or monitor — don't pile on.
6. Decide. Write the exec_summary like an analyst summarizing for a busy CEO: lead with the WHO and WHAT, give the impact, end with what (if anything) the exec might do.

GROUNDING REQUIREMENTS — CRITICAL CALIBRATION

These two failure modes have caused real false positives and burned exec trust. Read carefully:

(1) WORKFLOW CHANNELS HAVE A BASE RATE. DO NOT infer "systemic pattern" from flag count alone in a channel whose ENTIRE PURPOSE is to receive incident reports. Examples: #stolen_equipment exists FOR theft reports; #help-it exists FOR IT problems; #help-fleet exists FOR fleet asks. Three theft reports in #stolen_equipment over 4 days is the channel doing its job, not evidence of a systemic problem. Three IT tickets in #help-it is normal IT support volume.

When find_related_triage_flags returns multiple flags from the SAME workflow channel, that is NOT systemic-pattern evidence. To call something systemic you need at least ONE of:
  (a) Explicit pattern language in messages from humans: "again", "another", "every yard", "third time this week", "we keep seeing", "happening across markets"
  (b) The flagged incidents come from DIFFERENT channels / regions / authors (a real cross-cutting issue)
  (c) A senior person in the thread explicitly framing it as a pattern ("we have a process problem here")

If none of (a)-(c) apply, the events are independent. Don't string them together into a narrative.

(2) DO NOT INVENT PROCESS GAPS THAT THE MESSAGES DO NOT CLAIM. Your exec_summary and rationale must be grounded in what humans actually said. If no message in the evidence chain says "the off-rent trigger is too slow" or "the utilization monitoring is failing" or "the alert threshold is wrong", DO NOT put that framing in the summary. Tier B's job is to organize and elevate human signal, not to theorize root causes the humans haven't surfaced.

The test: for every causal / structural claim in your exec_summary ("Root cause: X", "This suggests Y", "Pattern indicates Z"), can you point to a specific human quote from the evidence that supports it? If no — strike it. Stick to what was said.

A factual report ("two assets stolen, police involved, recovery team responded in 4 minutes, GM coordinating with law enforcement") is fine. A speculative root cause ("the off-rent trigger is too slow") needs evidence.

(3) ACTIVE THREAD ENGAGEMENT IS A COUNTER-SIGNAL. If the thread shows multiple distinct people responding within minutes (recovery team, ops, corp), the operational system is working. Lean monitor or dismiss unless there's a SEPARATE exec-relevant signal beyond the incident itself. Don't escalate on the back of well-handled operational work.

OUTPUT REQUIREMENTS

You must respond with a structured object:
- decision: 'escalate' | 'monitor' | 'dismiss'
- severity: 1-5 (post-investigation, may differ from Tier A)
- exec_summary: <500 chars, plain English, exec-readable
- rationale: <2000 chars, the reasoning trail with concrete evidence
- evidence_refs: { channel_ids[], message_ts[], employee_ids[] }
- recommended_actions: up to 5 short concrete next-step suggestions (empty if dismiss)

Be calibrated. Roughly 10-30% of flagged items should escalate; the rest should split between monitor and dismiss. If you find yourself escalating every flag, you're not adding value over Tier A. If you're dismissing everything, you're not finding the real signal.

Important style notes for exec_summary:
- Lead with WHO ("Liz Hughson, Corp Web/Digital PM, has now relayed three customer-callbacks manually...")
- Specify the customer / branch / project when known.
- Quantify ("3 instances in 6 days") where possible.
- End with an inferred ask, not a vague observation. "Worth checking whether the AI tool routing is broken" beats "this seems concerning."`;

let cachedClient = null;
function getClient() {
  if (!cachedClient) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env.local or your shell env.");
    }
    cachedClient = new Anthropic();
  }
  return cachedClient;
}

// SDK tool runner expects run() to return a string (it pipes it into the
// tool_result content as text). Wrap object-returning helpers with JSON.stringify.
function asJson(handler) {
  return async (input) => {
    const result = await handler(input);
    return JSON.stringify(result ?? null, null, 2);
  };
}

export function buildTools(db) {
  return [
    betaZodTool({
      name: "fetch_message",
      description: "Get a single Slack message + its author's org context (corp/field, title, department, location, tenure).",
      inputSchema: z.object({
        slack_channel_id: z.string(),
        slack_ts: z.string(),
      }),
      run: asJson((input) => fetchMessage(db, input)),
    }),
    betaZodTool({
      name: "fetch_thread_replies",
      description: "Get the full thread (parent + ingested replies) for a given thread_ts in a channel. May return only the parent if thread replies have not been ingested yet.",
      inputSchema: z.object({
        slack_channel_id: z.string(),
        thread_ts: z.string(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      run: asJson((input) => fetchThreadReplies(db, input)),
    }),
    betaZodTool({
      name: "search_messages",
      description: "Substring search across all stored Slack messages. Returns up to N matches. Use distinctive phrases.",
      inputSchema: z.object({
        query: z.string().min(2),
        since_iso: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      run: asJson((input) => searchMessages(db, input)),
    }),
    betaZodTool({
      name: "get_channel_history",
      description: "Get recent messages from a channel before a given timestamp. Use to see what came before/around a flagged message.",
      inputSchema: z.object({
        slack_channel_id: z.string(),
        before_iso: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      run: asJson((input) => getChannelHistory(db, input)),
    }),
    betaZodTool({
      name: "lookup_employee",
      description: "Look up an employee by slack_user_id, employee_id, or full name. Returns full org context.",
      inputSchema: z.object({
        slack_user_id: z.string().optional(),
        employee_id: z.string().optional(),
        name: z.string().optional(),
      }),
      run: asJson((input) => lookupEmployee(db, input)),
    }),
    betaZodTool({
      name: "find_related_triage_flags",
      description: "Find other Tier A flags matching a given criterion. THE way to test for systemic patterns.",
      inputSchema: z.object({
        criterion: z.enum([
          "corporate_obstructing_field",
          "sales_relaying_customer_pain",
          "persistent_it_issue",
          "earnings_impacting_decision",
          "systemic_branch_pattern",
          "help_channel_dead_air",
          "ceo_fixable_friction",
        ]),
        since_iso: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      run: asJson((input) => findRelatedTriageFlags(db, input)),
    }),
    betaZodTool({
      name: "count_messages_by_author",
      description: "Count how many messages an author has posted since a given time. Useful for assessing baseline activity (new hire vs. habitual poster).",
      inputSchema: z.object({
        slack_user_id: z.string(),
        since_iso: z.string().optional(),
      }),
      run: asJson((input) => countMessagesByAuthor(db, input)),
    }),
  ];
}

export function buildInitialUserMessage(triageContext) {
  const { triageRun, message, channel, author } = triageContext;
  const lines = [];
  lines.push(`# Tier A flag for investigation`);
  lines.push("");
  lines.push(`Triage run id: ${triageRun.id}  (prompt_version=${triageRun.prompt_version}, model=${triageRun.model})`);
  lines.push(`Tier A severity: ${triageRun.severity}, primary criterion: ${triageRun.primary_criterion}`);
  lines.push(`Tier A reason: ${triageRun.reason}`);
  lines.push(`Tier A criteria_matched: ${triageRun.criteria_matched_json}`);
  lines.push("");
  lines.push(`Channel: #${channel.name} (${channel.channel_type})`);
  if (channel.priority_tier) {
    lines.push(`  Project channel — priority ${channel.priority_tier}, segment ${channel.segment_code}, customer ${channel.customer_slug}, project ${channel.project_number}`);
  }
  lines.push("");
  lines.push("Author:");
  if (author?.employee_id) {
    lines.push(`  ${author.full_name} (employee ${author.employee_id})`);
    lines.push(`  Title: ${author.employee_title ?? "n/a"}`);
    lines.push(`  ${author.is_corporate ? "Corporate" : "Field"} — Department: ${author.department_or_function ?? "n/a"}`);
    lines.push(`  Location: ${author.location ?? "n/a"}, state ${author.employee_state ?? "n/a"}, tenure ${author.tenure_years ?? "?"} yrs`);
    lines.push(`  Slack: ${author.slack_user_id} (${author.slack_username})`);
  } else if (author?.slack_user_id) {
    lines.push(`  Slack only: ${author.slack_user_id} (${author.slack_username ?? "?"}) — no employee link.`);
  } else {
    lines.push("  Unknown author");
  }
  lines.push("");
  lines.push(`Posted at: ${message.message_posted_at}`);
  lines.push(`Reply count: ${message.reply_count ?? "?"}`);
  lines.push("");
  lines.push("Message text:");
  lines.push("```");
  lines.push(message.text || "(empty body)");
  lines.push("```");
  lines.push("");
  lines.push("Investigate using the tools, then respond with the structured output. Take 2-5 tool calls if useful — don't decide on the prompt alone.");
  // Exec feedback is the correction signal. Include after triage context but
  // before the trailing JSON-output instruction.
  if (triageContext.exec_feedback_text) {
    lines.push("");
    lines.push(triageContext.exec_feedback_text);
  }
  return lines.join("\n");
}

function extractJsonFromText(text) {
  if (!text) return null;
  // Prefer fenced ```json blocks; fall back to the largest {...} block.
  const fenceMatch = /```json\s*([\s\S]*?)```/i.exec(text);
  if (fenceMatch) return JSON.parse(fenceMatch[1]);
  const fenceAnyMatch = /```\s*([\s\S]*?)```/.exec(text);
  if (fenceAnyMatch) {
    try { return JSON.parse(fenceAnyMatch[1]); } catch { /* fall through */ }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(text.slice(start, end + 1));
  }
  return null;
}

export async function investigateFlag(triageContext, db, modelOverride) {
  const client = getClient();
  const tools = buildTools(db);
  const userMessage = buildInitialUserMessage(triageContext) +
    "\n\nFinish your investigation by emitting a single JSON object that matches the InvestigationOutput schema. Wrap it in a ```json code fence so it can be parsed reliably. Do not output any prose after the JSON.";

  const model = modelOverride ?? pickInvestigationTier(triageContext.triageRun, db);
  const start = Date.now();
  const finalMessage = await client.beta.messages.toolRunner({
    model,
    max_tokens: 8000,
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    tools,
    messages: [{ role: "user", content: userMessage }],
  });
  const duration_ms = Date.now() - start;

  // Extract structured output from the final message's last text block.
  let lastText = "";
  for (const block of finalMessage.content ?? []) {
    if (block.type === "text" && block.text) lastText = block.text;
  }
  const rawJson = extractJsonFromText(lastText);
  if (!rawJson) {
    throw new Error(`Investigation produced no JSON. Last text: ${lastText.slice(0, 300)}`);
  }
  const parsed = InvestigationOutputSchema.parse(rawJson);

  return {
    parsed,
    usage: finalMessage.usage,
    duration_ms,
    model: finalMessage.model,
  };
}
