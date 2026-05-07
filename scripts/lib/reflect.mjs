// Tier C: daily reflection.
//
// Opus reads:
//   - All escalations created since the last reflection (or last N days)
//   - All exec feedback in the same window
//   - Recent triage_runs that DIDN'T get flagged but might in retrospect
//     (sample, to give the model false-negative visibility)
//
// And produces:
//   - A short exec-readable summary of what happened in the window
//   - A list of criterion proposals (new, edit, calibration, silence)
//
// Each proposal is persisted to criterion_proposals(status='pending').
// The exec reviews them via record-exec-feedback against
// target_type='criterion_proposal'. Proposals with status='accepted' are
// reflected in the next prompt-version bump (manual edit for now).

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv();

export const REFLECTION_PROMPT_VERSION = "reflect-v1";
export const REFLECTION_MODEL = "claude-opus-4-7";

// Free-string proposal_type to accommodate model variation; we normalize to
// the canonical set when persisting.
const CANONICAL_PROPOSAL_TYPES = ["new_criterion", "edit_criterion", "calibration_shift", "silence_pattern"];

export const ProposalSchema = z.object({
  proposal_type: z.string().min(2).max(80)
    .describe("One of: new_criterion, edit_criterion, calibration_shift, silence_pattern. Anything else will be normalized server-side."),
  proposed_change: z.string().min(10).max(2500)
    .describe("Plain English description of what you propose. Concrete and editable."),
  rationale: z.string().min(20).max(2500)
    .describe("Cite specific escalation IDs, feedback IDs, and intervention IDs that drove this proposal. The exec needs to verify your reasoning."),
  evidence_escalation_ids: z.array(z.number()).default([]),
  evidence_feedback_ids: z.array(z.number()).default([]),
  evidence_intervention_ids: z.array(z.number()).default([]),
});

export function normalizeProposalType(raw) {
  if (!raw || typeof raw !== "string") return "calibration_shift";
  const t = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if (CANONICAL_PROPOSAL_TYPES.includes(t)) return t;
  if (t.includes("new") && t.includes("criter")) return "new_criterion";
  if (t.includes("edit") || t.includes("update") || t.includes("modify")) return "edit_criterion";
  if (t.includes("calibrat") || t.includes("threshold") || t.includes("severity")) return "calibration_shift";
  if (t.includes("silen") || t.includes("filter") || t.includes("skip")) return "silence_pattern";
  return "calibration_shift"; // catch-all
}

export const ReflectionOutputSchema = z.object({
  window_summary: z.string().min(40).max(2000)
    .describe("3-5 sentence exec-readable summary of what the agent surfaced in this window — what the recurring themes were, what the exec said back, and any drift you noticed."),
  proposals: z.array(ProposalSchema).max(8)
    .describe("Up to 8 concrete proposals. Empty array is fine if nothing warrants a change."),
});

const SYSTEM_PROMPT = `You are the Tier C reflection layer of the EquipmentShare escalation agent. You run periodically (typically daily) and your job is to make the agent smarter over time by proposing changes to the escalation criteria, calibration, and content filters based on:

1. The escalations the agent surfaced in the last window
2. The free-text feedback the executives gave back
3. (Optionally) sampled un-flagged messages, so you have visibility into possible false negatives

You do NOT run on individual messages. You run on the AGGREGATE.

EXEC INTERVENTIONS — A SECOND GROUND-TRUTH SOURCE

In addition to explicit exec feedback, you also see "exec interventions" — messages where a watched executive (CEO, President, etc.) authored a message in a public channel, was @-mentioned, or otherwise touched a thread. These are EXTREMELY valuable signal because they show what the exec actually engages with, regardless of whether they remembered to leave you explicit feedback.

Treat exec interventions like this:
- An exec authoring a message in a channel/thread the agent did NOT escalate is a potential false-negative — they cared enough to engage but the agent didn't surface it. Strong candidate for new_criterion or calibration_shift.
- An exec being mentioned in a channel/thread is a softer signal — the engagement happened, the exec might or might not have responded.
- An exec authoring a message in a thread the agent DID escalate is calibration confirmation — the agent surfaced something they cared about.
- A pattern of an exec intervening in the same kind of channel/topic across multiple weeks IS a new criterion staring you in the face. Propose it.

Cite intervention IDs (intervention_id=N) the same way you cite escalation_id and feedback_id.

THE SEVEN CURRENT ESCALATION CRITERIA (in case they need recalibration)

1. corporate_obstructing_field
2. sales_relaying_customer_pain
3. persistent_it_issue
4. earnings_impacting_decision
5. systemic_branch_pattern
6. help_channel_dead_air
7. ceo_fixable_friction

PROPOSAL TYPES

Use 'new_criterion' when the data shows a recurring CEO-blind-spot pattern that none of the seven criteria cleanly capture. Be specific — what is the pattern, what's the trigger, what's an example? Not "we should flag bad customer experiences" but "we should flag any message where a field rep cites a specific customer-facing system error code (e.g., DEF dosing injector, fraud bounceback)."

Use 'edit_criterion' when the exec feedback shows an existing criterion is mis-defined. E.g., "ceo_fixable_friction" is firing too often on small things; tighten the definition.

Use 'calibration_shift' when the exec feedback shows the agent is over- or under-flagging some category. E.g., "flag earnings_impacting at sev 5 only when explicit dollar amounts are involved; otherwise sev 3-4."

Use 'silence_pattern' when the data shows recurring noise the agent should learn to skip. E.g., "Front bot integration messages get triaged sev=1 every time; add to structural pre-filter."

CRITICAL RULES

- Cite evidence by ID. The exec needs to verify that your proposal is grounded.
- Don't propose changes that contradict explicit exec feedback. If the exec said "I want more X", don't propose flagging X less.
- Don't propose more than is justified. Empty proposals array is the right answer if the window was uneventful or the criteria are working.
- Be conservative on new_criterion. Adding a new criterion is high-cost (more flags, more investigations); only propose when the pattern is recurring AND clearly outside the existing seven.
- When the exec gives free-text general guidance, treat it as ground truth. Translate it into a specific, actionable proposal.
- The window_summary should read like a 1-paragraph exec status report. Tell them what happened, what they liked, what they didn't, and what you propose changes about it.

OUTPUT FORMAT

You must emit a single JSON object wrapped in a \`\`\`json code fence. The exact shape is:

\`\`\`json
{
  "window_summary": "3-5 sentences summarizing what the agent surfaced, what the exec said back, and what's drifting.",
  "proposals": [
    {
      "proposal_type": "new_criterion" | "edit_criterion" | "calibration_shift" | "silence_pattern",
      "proposed_change": "Plain English description of the change. Concrete and editable.",
      "rationale": "Why you're proposing this. Cite escalation IDs and feedback IDs.",
      "evidence_escalation_ids": [11, 5, 2],
      "evidence_feedback_ids": [1, 2]
    }
  ]
}
\`\`\`

Required fields: window_summary, proposals (array, can be empty). Each proposal needs proposal_type, proposed_change, and rationale. evidence_*_ids arrays default to empty if you have no specific evidence.

Don't add prose around the JSON. Don't omit field names. Don't rename fields.`;

let cachedClient = null;
function getClient() {
  if (!cachedClient) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set.");
    }
    cachedClient = new Anthropic();
  }
  return cachedClient;
}

function pickRecommendedActions(json) {
  try {
    const a = JSON.parse(json ?? "[]");
    return Array.isArray(a) ? a.slice(0, 5) : [];
  } catch { return []; }
}

export function buildReflectionUserMessage({ escalations, feedback, interventions, sampleNonFlagged, windowStart, windowEnd }) {
  const lines = [];
  lines.push(`# Tier C reflection input — window ${windowStart} to ${windowEnd}`);
  lines.push("");
  lines.push(`## Escalations the agent surfaced (${escalations.length})`);
  if (escalations.length === 0) {
    lines.push("(none in window)");
  } else {
    for (const e of escalations) {
      lines.push(`- escalation_id=${e.id} | sev ${e.max_severity} | ${e.primary_criterion} | type=${e.cluster_type}`);
      lines.push(`  Author: ${e.author_full_name ?? e.author_slack_user_id ?? "—"} | Channel: ${e.channel_name ?? "—"}`);
      lines.push(`  Window: ${e.first_evidence_at?.slice(0,10)} → ${e.last_evidence_at?.slice(0,10)} | Evidence: ${e.evidence_message_count}`);
      lines.push(`  Exec action: ${e.exec_action ?? "pending"}`);
      lines.push(`  Summary: ${(e.representative_exec_summary ?? "").slice(0, 600)}`);
      const acts = pickRecommendedActions(e.representative_recommended_actions_json);
      if (acts.length) lines.push(`  Recommended actions: ${acts.slice(0, 3).join(" / ")}`);
      lines.push("");
    }
  }
  lines.push(`## Exec feedback in window (${feedback.length})`);
  if (feedback.length === 0) {
    lines.push("(none — agent has no calibration signal from execs in this window)");
  } else {
    for (const f of feedback) {
      const target = f.target_type === "escalation" && f.target_id
        ? `on escalation #${f.target_id}`
        : (f.target_type === "criterion_proposal" && f.target_id
          ? `on criterion proposal #${f.target_id}`
          : "(general)");
      lines.push(`- feedback_id=${f.id} | ${f.created_at?.slice(0,10)} | ${f.exec_name ?? "exec"} ${target} | sentiment=${f.sentiment ?? "—"}`);
      lines.push(`  Text: ${f.feedback_text}`);
      lines.push("");
    }
  }
  lines.push(`## Exec interventions in window (${interventions?.length ?? 0})`);
  lines.push("These are messages where a watched exec (CEO, President, etc.) authored or was @-mentioned in a public channel. Treat as ground-truth signal about what the exec cares about — especially when they intervene in a thread the agent did NOT escalate.");
  if (!interventions || interventions.length === 0) {
    lines.push("(none in window)");
  } else {
    for (const i of interventions) {
      lines.push(`- intervention_id=${i.id} | ${i.intervention_at?.slice(0,10)} | ${i.exec_display_name} ${i.intervention_type} in #${i.channel_name ?? i.slack_channel_id} | did_agent_escalate=${i.agent_escalated_this_thread ? "yes" : "no"}`);
      lines.push(`  Evidence: ${(i.evidence_text ?? "").slice(0, 280)}`);
      if (i.intervention_type === "mentioned" && i.author_full_name) {
        lines.push(`  Mentioned by: ${i.author_full_name}`);
      }
      lines.push("");
    }
  }
  if (sampleNonFlagged && sampleNonFlagged.length) {
    lines.push(`## Sampled un-flagged messages (${sampleNonFlagged.length}) — possible false negatives`);
    lines.push("These are messages the agent did NOT flag. Use them to identify patterns the criteria are missing.");
    for (const m of sampleNonFlagged) {
      lines.push(`- [${m.message_posted_at?.slice(0,10)}] #${m.channel_name} ${m.author_full_name ?? m.author_username ?? "?"}: ${m.text?.slice(0, 200)}`);
    }
    lines.push("");
  }
  lines.push("Reflect and emit your structured output. Cite escalation_id and feedback_id values where applicable.");
  return lines.join("\n");
}

export async function runReflection(input) {
  const client = getClient();
  const userContent = buildReflectionUserMessage(input);
  const start = Date.now();
  const response = await client.messages.create({
    model: REFLECTION_MODEL,
    max_tokens: 16000,
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: userContent }],
  });
  const duration_ms = Date.now() - start;
  // Extract the JSON output
  let lastText = "";
  for (const b of response.content ?? []) {
    if (b.type === "text" && b.text) lastText = b.text;
  }
  const fence = /```json\s*([\s\S]*?)```/i.exec(lastText) || /```\s*([\s\S]*?)```/.exec(lastText);
  if (!fence) throw new Error("No JSON found in Opus reflection response");
  const parsed = ReflectionOutputSchema.parse(JSON.parse(fence[1]));
  return { parsed, usage: response.usage, model: response.model, duration_ms };
}
