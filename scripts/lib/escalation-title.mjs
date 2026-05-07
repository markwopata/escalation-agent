// Generates a short human-readable title for an escalation.
//
// Goal: a 4-8 word headline an exec can read in <2 seconds and immediately
// know what the issue is. Examples we want:
//   "Apex Hubbard light plant shortfall"
//   "IT helpdesk dead-air, 17 days"
//   "Liz Hughson manual customer routing"
//   "Stargate fuel stoppage"
//
// Plus a short 1-sentence summary (~120 chars) for the digest sub-line.
// Both get persisted on the escalations row so we don't regenerate per send.
//
// Cheap: Haiku, ~200 input + ~30 output tokens per escalation = ~$0.0003 ea.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv();

const SYSTEM = `You write digest headlines for escalation alerts that go to top-three executives via Slack DM. Each headline is read for <2 seconds. Your job: produce a tight title and a one-sentence summary.

TITLE rules:
- 4-8 words
- Title Case
- Lead with the WHAT (incident / pattern / topic), not the WHO unless the person IS the story
- No emoji, no severity, no metadata — just the topic
- Examples: "Apex Hubbard light plant shortfall", "IT helpdesk dead-air, 17 days", "Liz Hughson manual customer routing", "Stargate fuel stoppage", "ESU training out of sync"

SUMMARY rules:
- One sentence
- 80-160 characters
- Concrete: who, what, why-it-matters
- No "this escalation describes…" preamble — just the facts
- Examples: "30 light plants unshipped from Bobcat with customer already sourcing 70 externally; VP told team to let them go elsewhere."

Your input is the existing exec_summary (a long paragraph). Compress it.`;

const TitleSchema = z.object({
  title: z.string().min(8).max(80).describe("4-8 word title in Title Case."),
  short_summary: z.string().min(40).max(400).describe("One-sentence summary, target 80-160 chars but up to 400."),
});

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    client = new Anthropic();
  }
  return client;
}

export async function generateTitle({ escId, criterion, exec_summary, channel_name, author_full_name }) {
  const userMsg = [
    `escalation_id: ${escId}`,
    `primary_criterion: ${criterion}`,
    channel_name ? `channel: #${channel_name}` : null,
    author_full_name ? `author: ${author_full_name}` : null,
    "",
    "Long exec summary to compress:",
    exec_summary ?? "(none)",
  ].filter(Boolean).join("\n");

  const response = await getClient().messages.parse({
    model: "claude-haiku-4-5",
    max_tokens: 256,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userMsg }],
    output_config: { format: zodOutputFormat(TitleSchema) },
  });
  return response.parsed_output;
}
