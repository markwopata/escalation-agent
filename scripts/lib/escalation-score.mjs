// Escalation ranking/scoring.
//
// Tier B over-escalates (it labels too many things "escalate" when really
// they belong on a "monitor" track). Rather than re-investigate, we score
// each pending escalation along multiple axes and let the digest take
// the top N.
//
// Target: 3-5 deliveries per recipient per day, hard cap 6.
//
// Weights here are calibrated by hand for now; Tier C reflection can
// propose adjustments (criterion_weight overrides) over time.

// Per-criterion base bonus. Higher = more exec-relevant on average.
// Adjust based on exec feedback over time.
const CRITERION_WEIGHT = {
  earnings_impacting_decision: 30,    // direct $ impact
  corporate_obstructing_field: 25,    // friction the CEO would fix
  sales_relaying_customer_pain: 25,   // customer voice surfacing
  systemic_branch_pattern: 22,        // multi-branch / multi-instance
  ceo_fixable_friction: 18,
  persistent_it_issue: 15,
  new_location_connectivity_blocker: 15,
  help_channel_dead_air: 8,           // common pattern, often workflow noise
  help_channel_dead_air_expansion: 8, // hallucinated criterion code variant
};
const DEFAULT_CRITERION_WEIGHT = 10;

// Severity is the dominant signal; criterion + others fine-tune order within a severity.
const SEVERITY_BASE = { 5: 100, 4: 50, 3: 20, 2: 5, 1: 0 };

const HOURS_RECENT_MAX_BONUS = 25;
const HOURS_RECENT_HALF_LIFE = 24;       // +25 right now, +0 by 48h

const DOLLAR_K_REGEX  = /\$\s?\d{1,3}([,.]\d+)?\s?[Kk]\b/;
const DOLLAR_M_REGEX  = /\$\s?\d{1,3}([,.]\d+)?\s?[Mm](?!in)/;  // exclude "Min"
const DOLLAR_NUM_LARGE_REGEX = /\$\s?\d{4,}/;                    // $10000+
const NAMED_CUSTOMER_REGEX = /named\s+(major\s+|key\s+|large\s+|hyperscale\s+)?(customer|account)/i;
const HARD_DEADLINE_REGEX = /\b(today|tomorrow|by\s+(monday|tuesday|wednesday|thursday|friday|next\s+\w+day)|deadline|hours?\s+ago|same[-\s]day)\b/i;

export function scoreEscalation(esc) {
  let score = 0;
  const reasons = [];

  // Severity
  const sevPoints = SEVERITY_BASE[esc.max_severity] ?? 0;
  score += sevPoints;
  reasons.push(`sev${esc.max_severity}=+${sevPoints}`);

  // Primary criterion
  const critPoints = CRITERION_WEIGHT[esc.primary_criterion] ?? DEFAULT_CRITERION_WEIGHT;
  score += critPoints;
  reasons.push(`${esc.primary_criterion}=+${critPoints}`);

  // Recency: bonus diminishes over 48h
  if (esc.last_evidence_at) {
    const hoursAgo = (Date.now() - new Date(esc.last_evidence_at).getTime()) / 3600000;
    if (hoursAgo >= 0) {
      const recencyPts = Math.max(0, Math.round(HOURS_RECENT_MAX_BONUS * (1 - hoursAgo / (HOURS_RECENT_HALF_LIFE * 2)) ));
      if (recencyPts > 0) {
        score += recencyPts;
        reasons.push(`recent(${hoursAgo.toFixed(0)}h)=+${recencyPts}`);
      }
    }
  }

  // Dollar magnitude in the exec summary
  const summary = esc.representative_exec_summary ?? esc.display_title_short_summary ?? "";
  let dollarBonus = 0;
  if (DOLLAR_M_REGEX.test(summary)) dollarBonus = 25;
  else if (DOLLAR_K_REGEX.test(summary)) dollarBonus = 12;
  else if (DOLLAR_NUM_LARGE_REGEX.test(summary)) dollarBonus = 8;
  if (dollarBonus > 0) { score += dollarBonus; reasons.push(`$amount=+${dollarBonus}`); }

  // Named major customer
  if (NAMED_CUSTOMER_REGEX.test(summary)) {
    score += 12;
    reasons.push(`named-customer=+12`);
  }

  // Hard deadline
  if (HARD_DEADLINE_REGEX.test(summary)) {
    score += 8;
    reasons.push(`hard-deadline=+8`);
  }

  return { score, reasons };
}

// Rank a list of escalations by score, take top N. Stable on ties.
export function rankAndCap(escalations, maxN = 6) {
  const scored = escalations.map(e => ({ ...e, _score: scoreEscalation(e) }));
  scored.sort((a, b) => {
    if (b._score.score !== a._score.score) return b._score.score - a._score.score;
    // tie-break by severity then recency
    if (b.max_severity !== a.max_severity) return b.max_severity - a.max_severity;
    return new Date(b.last_evidence_at ?? 0) - new Date(a.last_evidence_at ?? 0);
  });
  return scored.slice(0, maxN);
}

// Rank + balance across sources. When delivering more than 3 items, enforce a
// minimum of `sourceMin` items per source (capped by what's actually available
// in each source). Front-only and Slack-only days still work — the floor is
// "at most what exists." Below 4 items, balance is irrelevant; just rank.
//
// Why: when one channel (Slack OR Front) is dominating the score distribution,
// the digest ends up monosource, and the recipient loses cross-surface
// awareness. Mark's directive: "in a 6-message dump where you would have put
// 6 Front, drop the bottom 2 Front and put the top 2 Slack."
//
// Algorithm:
//   1. Score everything, sort desc.
//   2. If total fits within maxN, return all.
//   3. If maxN <= 3 OR only one source present, behave like rankAndCap.
//   4. Otherwise, reserve `min(sourceMin, available)` slots per source, take
//      the top of each source into those slots, then fill remaining slots
//      from a global score-ordered pool.
//   5. Re-sort the result by score for delivery order so the recipient still
//      sees the highest-impact item first.
export function rankAndBalance(escalations, maxN = 6, sourceMin = 2) {
  const scored = escalations.map(e => ({ ...e, _score: scoreEscalation(e) }));
  scored.sort((a, b) => {
    if (b._score.score !== a._score.score) return b._score.score - a._score.score;
    if (b.max_severity !== a.max_severity) return b.max_severity - a.max_severity;
    return new Date(b.last_evidence_at ?? 0) - new Date(a.last_evidence_at ?? 0);
  });
  if (scored.length <= maxN) return scored;

  const bySource = new Map();
  for (const e of scored) {
    const src = e.source || "slack";
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src).push(e);
  }

  // Below 4 deliveries, or only one source has candidates, just take top N.
  if (maxN <= 3 || bySource.size < 2) return scored.slice(0, maxN);

  // Reserve at least sourceMin per source (cap by available count). Don't
  // over-reserve — if reservations would exceed maxN, shrink each source's
  // reservation proportionally. In practice with 2 sources × 2 = 4 ≤ maxN=6,
  // this is fine.
  const reservations = new Map();
  let reservedTotal = 0;
  for (const [src, items] of bySource) {
    const r = Math.min(sourceMin, items.length);
    reservations.set(src, r);
    reservedTotal += r;
  }
  while (reservedTotal > maxN) {
    // Shrink the largest reservation by 1 until we fit.
    let largestSrc = null, largestN = -1;
    for (const [src, n] of reservations) {
      if (n > largestN) { largestN = n; largestSrc = src; }
    }
    if (!largestSrc) break;
    reservations.set(largestSrc, largestN - 1);
    reservedTotal -= 1;
  }

  // Take the reserved top items from each source.
  const taken = new Set();
  const result = [];
  for (const [src, n] of reservations) {
    const items = bySource.get(src).slice(0, n);
    for (const e of items) { result.push(e); taken.add(e.id); }
  }

  // Fill remaining slots greedily from the global score-ordered pool.
  for (const e of scored) {
    if (result.length >= maxN) break;
    if (taken.has(e.id)) continue;
    result.push(e);
    taken.add(e.id);
  }

  // Final delivery order: highest-score first.
  result.sort((a, b) => {
    if (b._score.score !== a._score.score) return b._score.score - a._score.score;
    if (b.max_severity !== a.max_severity) return b.max_severity - a.max_severity;
    return new Date(b.last_evidence_at ?? 0) - new Date(a.last_evidence_at ?? 0);
  });
  return result;
}
