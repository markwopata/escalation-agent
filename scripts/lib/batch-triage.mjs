// Batch API mode for Tier A triage. 50% discount on input + output tokens,
// 24-hour SLA. Right tool for the overnight pipeline.
//
// Two-step flow:
//   1. submit:  build per-message requests, send as one batch, persist
//               batch_id for polling
//   2. poll:    fetch batch status; when ended, iterate results, parse the
//               JSON output, persist as triage_runs (same row shape as live)
//
// We keep the batch_id mapping in a tiny `batch_jobs` table so the poll
// step knows what to do.
//
// Reuses everything from triage.mjs (system prompt, schema, user content
// builder). The only difference is the API call — submit a list of
// messages.create() params instead of awaiting one.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { loadLocalEnv } from "./load-env.mjs";
import { TriageResultSchema } from "./triage.mjs";

loadLocalEnv();

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

export function buildBatchRequest(customId, systemPrompt, userContent, model, schema) {
  return {
    custom_id: customId,
    params: {
      model,
      max_tokens: 1024,
      system: [
        { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: userContent }],
      output_config: { format: zodOutputFormat(schema) },
    },
  };
}

export async function submitTriageBatch(requests) {
  const client = getClient();
  return client.messages.batches.create({ requests });
}

export async function getBatchStatus(batchId) {
  const client = getClient();
  return client.messages.batches.retrieve(batchId);
}

export async function* iterateBatchResults(batchId) {
  const client = getClient();
  for await (const r of await client.messages.batches.results(batchId)) {
    yield r;
  }
}

// Parse a batch result row — returns { parsed, usage, model } or { error, raw }.
export function extractTriageResultFromBatchRow(row) {
  if (row.result?.type !== "succeeded") {
    return { error: row.result?.error ?? "unknown error", row };
  }
  const message = row.result.message;
  // The SDK populates parsed_output when output_config was specified.
  if (message?.parsed_output) {
    try {
      return {
        parsed: TriageResultSchema.parse(message.parsed_output),
        usage: message.usage,
        model: message.model,
      };
    } catch (err) {
      return { error: `parse error: ${err.message}`, row };
    }
  }
  // Fallback: extract JSON from the last text block. Batch results don't
  // populate parsed_output, but with output_config the model returns raw
  // JSON in the text block — try direct parse, then fenced as last resort.
  let text = "";
  for (const b of message?.content ?? []) {
    if (b.type === "text" && b.text) text = b.text;
  }
  text = text.trim();
  const tryParse = (s) => {
    try { return TriageResultSchema.parse(JSON.parse(s)); }
    catch { return null; }
  };
  if (text.startsWith("{")) {
    const parsed = tryParse(text);
    if (parsed) return { parsed, usage: message.usage, model: message.model };
  }
  const fence = /```json\s*([\s\S]*?)```/i.exec(text) || /```\s*([\s\S]*?)```/.exec(text);
  if (fence) {
    const parsed = tryParse(fence[1]);
    if (parsed) return { parsed, usage: message.usage, model: message.model };
  }
  return { error: "no parseable JSON in response", row };
}
