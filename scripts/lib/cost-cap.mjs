// Cost cap utility for the full-firehose proof. Pre-flight estimate of
// expected API spend; abort if over the configured cap.
//
// Pricing reference (as of writing — keep this in sync with current rates):
//   Haiku 4.5: $1 / $5 per MTok input/output. Cached read $0.10/MTok,
//              cached write $1.25/MTok. Batch API = 50% off all rates.
//   Sonnet 4.6: $3 / $15. Same caching multipliers, batch 50% off.
//   Opus 4.7: $5 / $25.

const RATES = {
  "claude-haiku-4-5": { input: 1, output: 5, cache_read: 0.10, cache_write: 1.25 },
  "claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0.30, cache_write: 3.75 },
  "claude-opus-4-7": { input: 5, output: 25, cache_read: 0.50, cache_write: 6.25 },
};

const BATCH_DISCOUNT = 0.5;

// Per-call typical token counts measured from spike runs.
// Adjust these if you see wildly different numbers in practice.
const TYPICAL_TOKENS = {
  // Tier A: cached system (~5K) + per-message user content (~500-1500) + ~100 output
  tier_a_slack: { input_fresh: 800, input_cached: 5400, output: 100 },
  tier_a_front: { input_fresh: 2000, input_cached: 5400, output: 200 },
  // Tier B: bigger context (recent thread, retrieval, exec feedback) + structured output
  tier_b: { input_fresh: 4000, input_cached: 8000, output: 1500 },
};

export function estimateCallCost({ model, mode, kind }) {
  const rates = RATES[model];
  if (!rates) throw new Error(`Unknown model for cost estimate: ${model}`);
  const t = TYPICAL_TOKENS[kind];
  if (!t) throw new Error(`Unknown call kind: ${kind}`);
  const factor = mode === "batch" ? BATCH_DISCOUNT : 1;
  // Assume cache is warm for the bulk of the run. Cold-start adds ~one cache_write call.
  const usd = (
    t.input_fresh * rates.input +
    t.input_cached * rates.cache_read +
    t.output * rates.output
  ) / 1_000_000;
  return usd * factor;
}

// Cold-start cache write — one-time per submission.
export function estimateColdStartCost(model, kind) {
  const rates = RATES[model];
  const t = TYPICAL_TOKENS[kind];
  return (t.input_cached * rates.cache_write) / 1_000_000;
}

export function estimateBudget({ items }) {
  // items: [{ model, mode, kind, count }]
  let total = 0;
  const breakdown = [];
  for (const item of items) {
    const perCall = estimateCallCost(item);
    const cold = estimateColdStartCost(item.model, item.kind);
    const subtotal = perCall * item.count + cold;
    breakdown.push({ ...item, per_call_usd: perCall, cold_start_usd: cold, subtotal_usd: subtotal });
    total += subtotal;
  }
  return { total_usd: total, breakdown };
}

export function enforceCap({ capUsd, estimate }) {
  if (estimate.total_usd > capUsd) {
    const lines = [
      `\nCOST CAP EXCEEDED.`,
      `Estimated total: $${estimate.total_usd.toFixed(2)}`,
      `Cap:             $${capUsd.toFixed(2)}`,
      `Breakdown:`,
    ];
    for (const b of estimate.breakdown) {
      lines.push(`  ${b.model} ${b.kind} ${b.mode}: ${b.count} × $${b.per_call_usd.toFixed(5)} + cold $${b.cold_start_usd.toFixed(4)} = $${b.subtotal_usd.toFixed(2)}`);
    }
    lines.push(``);
    lines.push(`Pass --force-over-cap to override (you'll be billed for what runs).`);
    throw new Error(lines.join("\n"));
  }
  return estimate;
}

export function formatEstimate(estimate, capUsd) {
  const lines = [];
  lines.push(`Estimated total: $${estimate.total_usd.toFixed(2)}${capUsd ? ` (cap $${capUsd})` : ""}`);
  for (const b of estimate.breakdown) {
    lines.push(`  ${b.model} ${b.kind} ${b.mode}: ${b.count} calls @ $${b.per_call_usd.toFixed(5)} = $${b.subtotal_usd.toFixed(2)}`);
  }
  return lines.join("\n");
}
