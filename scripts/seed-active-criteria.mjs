// One-shot seed: populate active_criteria with the original seven criteria
// (extracted verbatim from the Tier A system prompt) and silence_rules
// with the always-on structural-filter patterns.
//
// Idempotent — re-running won't duplicate. After this runs, the Tier A
// prompt can be built dynamically from active_criteria and the addition
// of new criteria via accepted proposals takes effect with zero code
// changes.

import { openDatabase, nowIso } from "./lib/db.mjs";

const db = openDatabase();
const now = nowIso();

const CRITERIA = [
  {
    code: "corporate_obstructing_field",
    name: "Corporate obstructing field",
    description: `A corporate / HQ employee is being obstinate, dismissive, process-bound, or unhelpful in response to a request from the field. The field is trying to serve a customer, run a yard, allocate equipment, or do their job, and corporate is in the way. Tone signals: "we don't do that", "that's not our process", "you'll need to go through X first", "not approved", or even silence. Outcome signals: the field's question goes unanswered, the corporate response shifts blame, or the corporate person enforces a rule that costs the customer or the field unnecessarily. The CEO's expectation is the opposite — corporate exists to support the field. When you see the inverse, flag it. NOTE: a corporate person responding helpfully to the field is the *baseline*, not a positive signal — only flag when the dynamic is genuinely obstructive.`,
  },
  {
    code: "sales_relaying_customer_pain",
    name: "Sales relaying customer pain",
    description: `A salesperson, account manager, territory manager, or any field employee is reporting customer pain on the customer's behalf inside Slack. Phrases to notice: "my customer is frustrated", "the customer is asking why X", "we promised X and didn't deliver", "the customer wants to talk to someone above me", "we're going to lose this account if". The point of this criterion is that the customer voice does not reach Slack directly — when it surfaces here, secondhand, it's already past the polite stage. Even routine-sounding "the customer is asking when their equipment ships" can matter if the customer is large or the delay is long.`,
  },
  {
    code: "persistent_it_issue",
    name: "Persistent IT issue",
    description: `A technical / IT problem that is recurring, blocking work, or affecting many people. Signals: multiple reports of the same error, "this happened again", "still doesn't work", a tool / system / dashboard / login that is broken or unreliable, mentions of specific internal apps (T3OS, ERP, Looker, Trackunit, Slack itself, the customer portal, billing, telematics) being down or behaving badly. A single "I can't log in" is not interesting; "I can't log in, and Joe and Sarah also reported this" is.`,
  },
  {
    code: "earnings_impacting_decision",
    name: "Earnings-impacting decision",
    description: `An operational decision being made (or NOT made) inside Slack that has clear financial consequence. Examples: a large equipment allocation choice, a rental discount, a credit hold release, a DNR (Do Not Rent) determination, a re-rent vs purchase decision, a delivery slip on a high-value project, a contract term change, a buy/sell decision on the rental fleet. The CEO cares about these even if the conversation seems routine, because patterns of poor judgment here compound.`,
  },
  {
    code: "systemic_branch_pattern",
    name: "Systemic branch pattern",
    description: `A signal that an issue may be systemic across multiple branches / markets / regions, not just a one-off. You will rarely see the full pattern in a single message — what to look for is language like "this keeps happening at every yard", "we're seeing this in Texas too", "third branch this month", "every market is reporting", or a question being asked again whose phrasing matches earlier asks. Lean toward flagging when a message reads like the latest instance of something repeating.`,
  },
  {
    code: "help_channel_dead_air",
    name: "Help channel dead air",
    description: `This is an ABSENCE signal. A request for help posted in a channel (help-* or any channel where the field is asking for routing/help) that has no response after a reasonable time, or where the conversation went silent before resolving.

RECENCY FLOOR — REQUIRED: Do NOT flag dead-air on a parent message that is less than 4 HOURS old. Threads in active project channels (gc-*, dc-*, customer channels) commonly route within minutes; calling something "dead air" seconds-to-minutes after it lands generates false positives. If the elapsed time since the parent post is < 4h, set worth_deeper_look=false and primary_criterion='none' for the dead-air check (other criteria can still apply). Only flag dead-air when (a) the parent is ≥4h old, (b) it has zero or near-zero thread replies, and (c) the parent is a clear ask, not a status post or social chatter.

The escalation worth here is "no one answered the field after a reasonable wait". DO NOT flag well-answered threads. DO NOT flag fresh (<4h) posts even if they currently have no replies — they're still in the normal-response-time window.`,
  },
  {
    code: "ceo_fixable_friction",
    name: "CEO-fixable friction",
    description: `"Stupid problems the CEO could fix with one phone call." Small, specific, fixable friction that is below the radar of normal escalation but visible to a leader. Examples: a new hire complaining that onboarding training doesn't match the actual product, a generally-good employee blocked because a form requires manual approval that takes weeks, broken / outdated docs that mislead customers, signage / branding inconsistency that hurts trust, a policy that no longer makes sense. The test: would the CEO read this and immediately say "I want this fixed" if it crossed his desk?`,
  },
];

const insertCriterion = db.prepare(`
  INSERT INTO active_criteria (code, name, description, active, source, created_at, modified_at)
  VALUES (?, ?, ?, 1, 'seed', ?, ?)
  ON CONFLICT(code) DO NOTHING
`);
for (const c of CRITERIA) {
  insertCriterion.run(c.code, c.name, c.description, now, now);
}

// Seed silence rules from the structural-filter patterns. Most are still
// hardcoded in lib/structural-filter.mjs (always-on safety net); the rules
// here are the ones we want the system to be able to add/remove dynamically.
const SILENCE_SEEDS = [
  {
    rule_type: "text_regex",
    pattern: "^Hello,?\\s+a\\s+ticket\\s+has\\s+been\\s+created",
    reason: "IT Support bot auto-confirmation in #help-it",
    scope_channel_id: null,
  },
  {
    rule_type: "text_regex",
    pattern: "\\bconnected the .*\\bFront\\b.*\\bintegration\\b",
    reason: "Front integration setup confirmation",
    scope_channel_id: null,
  },
];
const insertRule = db.prepare(`
  INSERT INTO silence_rules (rule_type, pattern, scope_channel_id, reason, active, source, created_at)
  VALUES (?, ?, ?, ?, 1, 'seed', ?)
`);
const existingRules = new Set(
  db.prepare("SELECT pattern FROM silence_rules").all().map(r => r.pattern)
);
for (const r of SILENCE_SEEDS) {
  if (existingRules.has(r.pattern)) continue;
  insertRule.run(r.rule_type, r.pattern, r.scope_channel_id, r.reason, now);
}

console.log("Active criteria:");
console.table(db.prepare("SELECT code, name, active, source FROM active_criteria").all());
console.log("\nSilence rules:");
console.table(db.prepare("SELECT id, rule_type, pattern, reason, source FROM silence_rules").all());
