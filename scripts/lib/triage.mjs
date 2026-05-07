// Tier A triage: cheap, fast LLM (Haiku) flags messages that warrant a deeper
// look by Tier B. The system prompt and the set of active criteria are now
// data-driven — see ./triage-prompt.mjs. This module owns the API call,
// schema, and per-message user content; it pulls the prompt and prompt version
// from the DB at runtime so accepted criterion proposals take effect with
// zero code changes.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { loadLocalEnv } from "./load-env.mjs";
import {
  buildSystemPrompt,
  buildPromptVersion,
  loadActiveCriterionCodes,
} from "./triage-prompt.mjs";

loadLocalEnv();

export const TRIAGE_MODEL = "claude-haiku-4-5";

// Runtime version derived from current active_criteria + prompt_overrides.
// New accepted proposals automatically bump this hash, so the next triage
// run treats prior-version triage_runs as stale and re-evaluates them.
export function getTriagePromptVersion(db) {
  return buildPromptVersion(db);
}

// Loose schema — accepts any string for criterion codes. Used by lazy
// parsing paths (batch result extractors, file replay) where we don't have
// a db handle and don't want to reject the row just because the active set
// has shifted between submission and parse.
export const TriageResultSchema = z.object({
  worth_deeper_look: z.boolean()
    .describe("True if a senior exec should have visibility on this thread; otherwise false."),
  severity: z.number().int().min(1).max(5)
    .describe("1 = routine, 5 = drop-everything. Use 1 for clearly routine messages."),
  primary_criterion: z.string()
    .describe("The single best-fitting criterion code, or 'none' if not worth a deeper look."),
  criteria_matched: z.array(z.string())
    .describe("All criterion codes that apply (zero or more)."),
  reason: z.string().min(1).max(800)
    .describe("One or two short sentences (target ~250 chars, max 800) explaining the signal you saw or why it's routine."),
});

// Strict schema built from the current active criterion codes. Use this for
// API calls so the SDK validates the model's output against the live set.
export function buildTriageResultSchema(codes) {
  const all = [...codes];
  if (all.length === 0) all.push("none");
  const primaryEnum = z.enum([...all, "none"]);
  const matchedEnum = z.enum(all);
  return z.object({
    worth_deeper_look: z.boolean()
      .describe("True if a senior exec should have visibility on this thread; otherwise false."),
    severity: z.number().int().min(1).max(5)
      .describe("1 = routine, 5 = drop-everything. Use 1 for clearly routine messages."),
    primary_criterion: primaryEnum
      .describe("The single best-fitting criterion, or 'none' if not worth a deeper look."),
    criteria_matched: z.array(matchedEnum)
      .describe("All criteria that apply (zero or more)."),
    reason: z.string().min(1).max(800)
      .describe("One or two short sentences (target ~250 chars, max 800) explaining the signal you saw or why it's routine."),
  });
}

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

// Build the per-message user content. Stable structure, content varies — placed
// AFTER the cached system prompt so the prefix stays cacheable.
export function buildTriageUserContent(ctx) {
  const lines = [];
  lines.push(`Channel: #${ctx.channel.name} (${ctx.channel.channel_type ?? "unknown type"})`);
  if (ctx.channel.priority_tier) {
    lines.push(`  Project channel — priority ${ctx.channel.priority_tier}, segment ${ctx.channel.segment_code}, customer ${ctx.channel.customer_slug}, project ${ctx.channel.project_number}`);
  }
  lines.push("");
  lines.push("Message author:");
  if (ctx.author?.employee_id) {
    lines.push(`  ${ctx.author.full_name} (employee ${ctx.author.employee_id})`);
    lines.push(`  Title: ${ctx.author.employee_title ?? "n/a"}`);
    lines.push(`  Corporate or Field: ${ctx.author.is_corporate ? "Corporate" : "Field"}`);
    lines.push(`  Department: ${ctx.author.department_or_function ?? "n/a"}${ctx.author.sub_department_or_team ? " / " + ctx.author.sub_department_or_team : ""}`);
    lines.push(`  Location: ${ctx.author.location ?? "n/a"}, state ${ctx.author.employee_state ?? "n/a"}`);
    lines.push(`  Tenure: ${ctx.author.tenure_years ?? "?"} years`);
  } else if (ctx.author?.slack_user_id) {
    lines.push(`  ${ctx.author.author_username ?? ctx.author.slack_user_id} (Slack only — no employee record linked)`);
  } else {
    lines.push(`  unknown author`);
  }
  lines.push("");
  lines.push(`Posted: ${ctx.message.message_posted_at ?? "?"} (${ctx.message.elapsed_human ?? "?"} ago)`);
  if (ctx.message.is_bot) {
    lines.push(`  (Bot / integration message)`);
  }
  if (ctx.message.reply_count != null) {
    lines.push(`  Thread reply count: ${ctx.message.reply_count}`);
  }
  lines.push("");
  lines.push("Mentions in this message:");
  if (ctx.mentions && ctx.mentions.length) {
    for (const m of ctx.mentions) {
      if (m.full_name) {
        lines.push(`  - ${m.full_name} (${m.is_corporate ? "Corp" : "Field"}, ${m.employee_title ?? "n/a"})`);
      } else {
        lines.push(`  - ${m.slack_user_id} (no employee link)`);
      }
    }
  } else {
    lines.push("  (none)");
  }
  lines.push("");
  lines.push("Recent prior messages in this channel (most recent first, max 6 — time-ordered, not author-filtered):");
  if (ctx.recent && ctx.recent.length) {
    for (const r of ctx.recent) {
      const who = r.full_name ?? r.author_username ?? "unknown";
      const role = r.is_corporate == null ? "" : (r.is_corporate ? " [Corp]" : " [Field]");
      lines.push(`  - [${r.message_posted_at}] ${who}${role}: ${r.text.slice(0, 200)}${r.text.length > 200 ? "…" : ""}`);
    }
  } else {
    lines.push("  (no prior messages available)");
  }
  if (ctx.retrieval_text) {
    lines.push("");
    lines.push(ctx.retrieval_text);
  }
  if (ctx.exec_feedback_text) {
    lines.push("");
    lines.push(ctx.exec_feedback_text);
  }
  lines.push("");
  lines.push("=== MESSAGE TO TRIAGE ===");
  lines.push(ctx.message.text || "(empty body)");
  return lines.join("\n");
}

// Drives one Tier A triage call. Builds the system prompt + strict schema
// from the live DB state — accepted criterion proposals are picked up here.
export async function triageMessage(db, ctx) {
  const client = getClient();
  const userContent = buildTriageUserContent(ctx);
  const { prompt: systemPrompt } = buildSystemPrompt(db);
  const codes = loadActiveCriterionCodes(db);
  const schema = buildTriageResultSchema(codes);

  const start = Date.now();
  const response = await client.messages.parse({
    model: TRIAGE_MODEL,
    max_tokens: 1024,
    system: [
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      { role: "user", content: userContent },
    ],
    output_config: { format: zodOutputFormat(schema) },
  });
  const duration_ms = Date.now() - start;

  return {
    parsed: response.parsed_output,
    usage: response.usage,
    duration_ms,
    model: response.model,
  };
}
