// Apply an accepted criterion_proposal to the live tables. This is the
// "self-healing" write step:
//
//   - new_criterion       → INSERT into active_criteria
//   - edit_criterion      → UPDATE active_criteria (description) — falls back
//                           to inserting a prompt_override if the proposal
//                           doesn't name an existing criterion code
//   - calibration_shift   → INSERT into prompt_overrides
//   - silence_pattern     → INSERT into silence_rules
//
// The proposal's `proposed_change` is plain English. We use Haiku with a
// structured-output schema to convert it to concrete fields. The rationale
// is preserved untouched — execs can audit it later.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { loadLocalEnv } from "./load-env.mjs";
import { nowIso } from "./db.mjs";
import { normalizeProposalType } from "./reflect.mjs";

loadLocalEnv();

const EXTRACTION_MODEL = "claude-haiku-4-5";

let cachedClient = null;
function getClient() {
  if (!cachedClient) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set.");
    cachedClient = new Anthropic();
  }
  return cachedClient;
}

const NewCriterionSchema = z.object({
  code: z.string().min(3).max(60).regex(/^[a-z][a-z0-9_]+$/, "snake_case identifier")
    .describe("Stable snake_case identifier. e.g. 'new_location_connectivity_blocker'."),
  name: z.string().min(3).max(80)
    .describe("Short Title-Case display name."),
  description: z.string().min(80).max(1500)
    .describe("Full prose definition of the criterion as it should appear in the Tier A system prompt — what the pattern is, what to look for, when to flag it. Multiple short paragraphs OK."),
  default_severity: z.number().int().min(1).max(5).optional()
    .describe("Default severity when the criterion matches; omit if not specified in the proposal."),
});

const EditCriterionSchema = z.object({
  code: z.string().min(3).max(60)
    .describe("The existing criterion's snake_case code (must match an active row). If the proposal doesn't clearly name an existing code, use 'none' and the change will be applied as a prompt_override instead."),
  new_description: z.string().min(40).max(1500).optional()
    .describe("Replacement description text. Omit if the proposal is purely a calibration shift (use override_text instead)."),
  override_text: z.string().min(20).max(1500).optional()
    .describe("Calibration adjustment text appended to the prompt as an override. Use this when the proposal tightens/loosens behavior without rewriting the criterion."),
});

const CalibrationShiftSchema = z.object({
  override_text: z.string().min(20).max(1500)
    .describe("Self-contained calibration directive that will be inserted into the system prompt as a high-priority override. Concrete and actionable — the LLM should be able to act on it without further context. Reference specific criteria/channels/severity bands as needed."),
});

const SilencePatternSchema = z.object({
  rule_type: z.enum(["text_regex", "channel_regex", "author_username"])
    .describe("text_regex matches message text. channel_regex matches the channel name. author_username matches the author exactly."),
  pattern: z.string().min(2).max(400)
    .describe("The regex (for text_regex/channel_regex) or exact author username (for author_username). Use case-insensitive style (regex flags are added by the runtime)."),
  reason: z.string().min(10).max(200)
    .describe("Short human-readable reason — shows up in triage_runs.reason when the rule fires."),
  scope_channel_id: z.string().nullable().optional()
    .describe("If the rule should only apply in one channel, pass its slack_channel_id (Cxxxxxxx). Otherwise null."),
});

async function extractStructured(systemInstr, proposedChange, schema) {
  const client = getClient();
  const response = await client.messages.parse({
    model: EXTRACTION_MODEL,
    max_tokens: 1500,
    system: systemInstr,
    messages: [{ role: "user", content: `Convert this proposal into the required structured fields. Be faithful to the original intent — do not invent constraints not present in the source.\n\nPROPOSAL:\n${proposedChange}` }],
    output_config: { format: zodOutputFormat(schema) },
  });
  return response.parsed_output;
}

async function applyNewCriterion(db, proposal, decidedBy) {
  const extracted = await extractStructured(
    "You convert an accepted Tier C proposal into a new escalation criterion row. Extract code (snake_case identifier), name (Title Case), description (the full prompt-level definition that tells the Tier A model what to flag), and default_severity if specified.",
    proposal.proposed_change,
    NewCriterionSchema,
  );
  const now = nowIso();
  // If a row with this code already exists (rejected previously, then re-proposed),
  // re-activate and update.
  const existing = db.prepare("SELECT code FROM active_criteria WHERE code = ?").get(extracted.code);
  if (existing) {
    db.prepare(`
      UPDATE active_criteria
      SET name = ?, description = ?, default_severity = ?, active = 1,
          source = ?, modified_at = ?, modified_by = ?
      WHERE code = ?
    `).run(extracted.name, extracted.description, extracted.default_severity ?? null,
           `proposal#${proposal.id}`, now, decidedBy, extracted.code);
  } else {
    db.prepare(`
      INSERT INTO active_criteria (code, name, description, default_severity, active, source, created_at, modified_at, modified_by)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(extracted.code, extracted.name, extracted.description, extracted.default_severity ?? null,
           `proposal#${proposal.id}`, now, now, decidedBy);
  }
  return { table: "active_criteria", code: extracted.code, ...extracted };
}

async function applyEditCriterion(db, proposal, decidedBy) {
  const activeCodes = db.prepare("SELECT code FROM active_criteria WHERE active = 1").all().map(r => r.code);
  const systemInstr = `You convert an accepted Tier C edit_criterion proposal into the right table change. The currently-active criterion codes are: ${activeCodes.join(", ")}. If the proposal clearly names one of these (or strongly implies one), set code to that exact value and provide new_description (or override_text if it's just a calibration tweak). If the proposal does NOT clearly name an existing criterion, set code='none' and provide override_text — the change will be applied as a calibration override instead.`;
  const extracted = await extractStructured(systemInstr, proposal.proposed_change, EditCriterionSchema);
  const now = nowIso();

  if (extracted.code !== "none" && extracted.new_description && activeCodes.includes(extracted.code)) {
    db.prepare(`
      UPDATE active_criteria SET description = ?, source = ?, modified_at = ?, modified_by = ?
      WHERE code = ?
    `).run(extracted.new_description, `proposal#${proposal.id}`, now, decidedBy, extracted.code);
    return { table: "active_criteria", code: extracted.code, action: "description_replaced" };
  }
  // Fallback: persist as override.
  const overrideText = extracted.override_text ?? proposal.proposed_change;
  const result = db.prepare(`
    INSERT INTO prompt_overrides (override_text, rationale, active, source, created_at, applied_by)
    VALUES (?, ?, 1, ?, ?, ?)
  `).run(overrideText, proposal.rationale ?? null, `proposal#${proposal.id}`, now, decidedBy);
  return { table: "prompt_overrides", id: result.lastInsertRowid, action: "override_inserted" };
}

async function applyCalibrationShift(db, proposal, decidedBy) {
  const extracted = await extractStructured(
    "You convert an accepted Tier C calibration_shift proposal into a single override directive that will be appended to the Tier A system prompt. Be concrete and actionable; reference criteria/channels/severities as the proposal does. The LLM should be able to act on it without further context.",
    proposal.proposed_change,
    CalibrationShiftSchema,
  );
  const now = nowIso();
  const result = db.prepare(`
    INSERT INTO prompt_overrides (override_text, rationale, active, source, created_at, applied_by)
    VALUES (?, ?, 1, ?, ?, ?)
  `).run(extracted.override_text, proposal.rationale ?? null, `proposal#${proposal.id}`, now, decidedBy);
  return { table: "prompt_overrides", id: result.lastInsertRowid, override_text: extracted.override_text };
}

async function applySilencePattern(db, proposal, decidedBy) {
  const extracted = await extractStructured(
    "You convert an accepted Tier C silence_pattern proposal into a structured silence rule. Choose rule_type carefully: text_regex when matching message body, channel_regex when matching channel names, author_username when matching a known bot/integration author exactly. Keep the pattern tight — over-broad regexes silently swallow real signal.",
    proposal.proposed_change,
    SilencePatternSchema,
  );
  const now = nowIso();
  // Validate regex compiles before inserting (text_regex/channel_regex).
  if (extracted.rule_type !== "author_username") {
    try { new RegExp(extracted.pattern, "i"); }
    catch (err) { throw new Error(`Extracted regex doesn't compile: ${err.message}`); }
  }
  const result = db.prepare(`
    INSERT INTO silence_rules (rule_type, pattern, scope_channel_id, reason, active, source, created_at, applied_by)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
  `).run(extracted.rule_type, extracted.pattern, extracted.scope_channel_id ?? null,
         extracted.reason, `proposal#${proposal.id}`, now, decidedBy);
  return { table: "silence_rules", id: result.lastInsertRowid, ...extracted };
}

// Public entry point. `decision` is either 'accept' or 'reject'.
export async function applyProposal(db, proposalId, { decision, decidedBy }) {
  const proposal = db.prepare("SELECT * FROM criterion_proposals WHERE id = ?").get(proposalId);
  if (!proposal) throw new Error(`No proposal #${proposalId}`);
  if (proposal.status !== "pending") {
    return { proposal_id: proposalId, status: proposal.status, skipped: true };
  }

  if (decision === "reject") {
    db.prepare(`UPDATE criterion_proposals SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ?`)
      .run(nowIso(), decidedBy, proposalId);
    return { proposal_id: proposalId, status: "rejected" };
  }

  if (decision !== "accept") throw new Error(`Unknown decision: ${decision}`);

  const proposalType = normalizeProposalType(proposal.proposal_type);
  let applied;
  switch (proposalType) {
    case "new_criterion":     applied = await applyNewCriterion(db, proposal, decidedBy); break;
    case "edit_criterion":    applied = await applyEditCriterion(db, proposal, decidedBy); break;
    case "calibration_shift": applied = await applyCalibrationShift(db, proposal, decidedBy); break;
    case "silence_pattern":   applied = await applySilencePattern(db, proposal, decidedBy); break;
    default: throw new Error(`Unknown proposal_type: ${proposal.proposal_type}`);
  }

  db.prepare(`UPDATE criterion_proposals SET status = 'accepted', decided_at = ?, decided_by = ? WHERE id = ?`)
    .run(nowIso(), decidedBy, proposalId);

  return { proposal_id: proposalId, status: "accepted", proposal_type: proposalType, applied };
}
