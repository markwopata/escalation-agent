# Escalation Agent

A reference architecture for an LLM-powered "exec digest" — an agent that watches Slack and shared inboxes (Front), filters internal organizational dysfunction from routine workflow, and delivers a daily DM-sized digest of items the leadership team should personally see.

This repo is **a worked example**, not a turnkey product. It was built for a specific company's signals (construction-equipment rental ops). The patterns it demonstrates are the part worth copying; the prompts and silence rules are the part you'll rewrite for your own domain.

> **Status:** functional in production for one team. Single-tenant, single SQLite database, hand-tuned to the org's vocabulary. Prompts and filter rules embed real org-specific calibration (workflow channels, customer-form patterns, etc.) — read them as examples of *how the calibration is expressed*, not as something to deploy as-is.

---

## What problem this solves

Most signal an exec needs to see is buried under noise:

- A field GM posts a $100K warranty dispute in `#help-warranty` and gets no reply for 11 days. Real signal.
- A customer emails three times asking about a delivery and gets archived without a reply. Real signal.
- Two ex-employees keep charging on company cards after termination. Real signal.

The same exec also gets dragged into:

- Auto-mailed quote emails that don't need a reply (Front records archive-without-reply as "dead air").
- Service-inbox handoffs between internal employees coordinating dispatch.
- Threads where the field is *actively* engaged and the operational system is working — but a naive "X messages, no resolution" rule flags them as crises.

The job of this agent is to **find the first list and reliably filter out the second**. It does that with a tiered LLM cascade, a digest-time revalidation step, and a feedback loop where exec corrections become ground-truth calibration on the next run.

---

## High-level architecture

```
   ┌─────────────┐    ┌──────────────────┐    ┌──────────────────┐
   │ Slack ingest│    │   Tier A (Haiku) │    │   Tier B (Sonnet)│
   │   (hourly)  ├───►│   triage batch   ├───►│   investigation  │
   └─────────────┘    │   ~$0.001/msg    │    │   tool-using     │
   ┌─────────────┐    │  10-20% flagged  │    │  ~$0.05/decision │
   │ Front ingest├───►│                  │    │  ~30% escalate   │
   │ (Snowflake) │    └──────────────────┘    └──────────────────┘
   └─────────────┘                                     │
                                                       ▼
   ┌──────────────────┐    ┌──────────────────┐    ┌──────────┐
   │   Daily digest   │◄───│  Digest-time     │◄───│  Rollup  │
   │   5:30 AM local  │    │  revalidation    │    │ + dedupe │
   │   to N execs     │    │  (live thread    │    │          │
   │   ≤6 messages    │    │   state check)   │    │          │
   └──────────────────┘    └──────────────────┘    └──────────┘
                                                       ▲
                                          ┌────────────┘
                                          │
                                  ┌───────────────┐
                                  │ exec_feedback │
                                  │ (DM reactions)│
                                  └───────────────┘
                                          │
                                          ▼
                                  ┌───────────────┐
                                  │ Tier C (Opus) │
                                  │ reflection    │
                                  │ → prompt      │
                                  │   adjustments │
                                  └───────────────┘
```

### The cascade

**Tier A — Haiku triage** (`scripts/triage-front-batch.mjs`, `scripts/triage-batch.mjs`)
- Fast and cheap. Runs against every ingested message via Anthropic's Batch API.
- Output: `worth_deeper_look: bool`, `severity: 1-5`, `primary_criterion`, `reason`.
- Calibrated to flag ~10–20% of a busy channel; everything else is severity 1.
- Includes a **structural pre-filter** (`scripts/lib/structural-filter.mjs`) that drops obvious non-signals (auto-confirmation bots, telematics alerts, automated quote emails) BEFORE LLM cost.

**Tier B — Sonnet investigation** (`scripts/lib/investigate.mjs`)
- Tool-using agent (`betaZodTool`) that pulls thread context, related flags, author tenure, and surrounding channel history before deciding `escalate | monitor | dismiss`.
- Output: `decision`, `severity`, `exec_summary` (≤500 chars, exec-readable), `rationale` (≤2000 chars), `recommended_actions`, `evidence_refs`.
- The prompt encodes hard-won calibration: don't infer "systemic" from same-workflow-channel flag count alone; don't invent process gaps the messages don't claim; active multi-author engagement is a counter-signal.

**Tier C — Opus reflection** (`scripts/lib/reflect.mjs`, `scripts/run-reflection.mjs`)
- Periodic. Reads the last N decisions, exec feedback, and outcomes; proposes prompt adjustments and silence rules.
- Approved proposals modify `active_criteria` and `silence_rules` tables — the next Tier A/B run picks them up with no code change because prompts are built dynamically (`scripts/lib/triage-prompt.mjs`).

### Rollup

`scripts/roll-up-escalations.mjs` and `scripts/roll-up-front-escalations.mjs` cluster Tier B's `escalate` decisions into one row per *underlying issue*:

- **Author cluster** — same person flagged multiple times in 30 days (e.g., a corp PM relaying customer pain three times).
- **Channel + criterion cluster** — same channel, same criterion, ≥2 flags in 7 days (e.g., dead-air pattern across multiple authors).
- **Customer cluster (Front)** — same customer (extracted from subject + body), ≥2 conversations in 14 days.
- **Singleton** — anything left.

The rollup also writes `signal_event_at` per cluster: the most recent customer event timestamp. The digest dedupe uses this to decide whether a previously-delivered escalation has had new activity worth re-surfacing.

### Digest-time revalidation

`scripts/lib/digest-revalidate.mjs` checks each Slack-sourced escalation against current thread state via `conversations.replies` AND `conversations.history` (4-hour window after parent post) just before delivery. Drops the escalation if:

1. Criterion is dead-air AND the thread now has replies, OR
2. Summary contains anti-dead-air language (`no reply`, `unanswered`, `still waiting`...) AND thread engaged, OR
3. **Active engagement counter-signal**: ≥5 thread replies, OR ≥3 distinct other authors in channel within 4h. Field has ownership; exec doesn't need to step in.

This is the most important pattern in the system. Tier B runs are async — by the time a digest fires, the underlying thread may have been resolved. Without this step you ship "this is dead air" claims that became false 6 hours ago.

### Source-balanced delivery

`scripts/lib/escalation-score.mjs` `rankAndBalance()`:

- Score each candidate (severity base + criterion weight + recency bonus + dollar magnitude + named-customer + hard-deadline).
- When delivering >3 items, reserve at least N slots per source (Slack, Front) so the digest never goes mono-source on a quiet day.
- **Sev-floor backfill**: always include the top sev-5 items from a 30-day window if not already in the pool; sev-5 is rare and exec-relevant by definition, aging out of the 24h fresh window is wrong default.
- **Source-min backfill**: if fresh window has <N viable candidates of one source, reach back 30 days for that source only.

### Customer-event-driven dedupe

Once an escalation is delivered to an exec, `digest_deliveries` tracks `delivered_at`. The dedupe rule is:

```sql
AND (last_delivered_at IS NULL OR signal_event_at > last_delivered_at)
```

Translation: deliver again ONLY if a new customer event (e.g., the customer emailed back) has arrived since the last delivery. A long-pending escalation doesn't reappear day after day — but it *does* reappear if the customer follows up.

---

## The patterns most worth copying

If you're adapting this for a different domain, these are the parts to lift:

| # | Pattern | File | Why it matters |
|---|---|---|---|
| 1 | **Tiered LLM cascade** (Haiku → Sonnet → Opus) | `scripts/lib/triage.mjs`, `scripts/lib/investigate.mjs`, `scripts/lib/reflect.mjs` | Run the cheap model on the firehose; spend Sonnet only on flagged items. Order-of-magnitude cost difference vs. Sonnet-everywhere. |
| 2 | **Dynamic prompt assembly from DB** | `scripts/lib/triage-prompt.mjs` | Criteria, exec feedback, and silence rules live in tables. Prompts are built at runtime; accepted Tier C proposals take effect with zero code changes. Prompt version is a hash of the dynamic content. |
| 3 | **Workflow-channel detection** | `scripts/lib/structural-filter.mjs`, `silence_rules` table | Not every channel that *looks* busy is producing exec-relevant signal. `#stolen_equipment` exists for theft reports — high volume there is the channel functioning, not dysfunction. |
| 4 | **Digest-time revalidation** | `scripts/lib/digest-revalidate.mjs` | Tier B's decision can be stale by delivery time. Always re-check the source state at the moment of delivery. The single highest-leverage trust-building step in the system. |
| 5 | **Active-engagement counter-signal** | same | Multi-author engagement on a thread is evidence the operational system is working. Drop "no one's on it" alerts when actually three people are on it. |
| 6 | **Customer-event-driven dedupe** | `scripts/send-digest.mjs` `loadPendingEscalationsForRecipient()` | Re-deliver only when something materially changed. Avoids the "same 6 messages every morning" failure mode while still surfacing items that customers are actively pushing on. |
| 7 | **Source-min + sev-floor backfill** | `scripts/lib/escalation-score.mjs` `rankAndBalance()` | Cross-surface visibility on quiet days. Exec sees something from Slack AND something from Front, not 6-of-one. |
| 8 | **Multi-token Slack routing** | `scripts/lib/slack-token-router.mjs` | Workspaces without Discovery API require per-user channel membership. Route each channel pull to a token whose owner is a member. Persist membership to `channel_token_access` for fast lookup. |
| 9 | **Exec feedback as ground-truth calibration** | `scripts/lib/exec-feedback-context.mjs` | Reactions/replies on delivered items become text injected into Tier B's next prompt. The model treats exec feedback as authoritative; criteria are a hypothesis, exec is the correction signal. |
| 10 | **Retriage-respect in rollup** | `scripts/roll-up-escalations.mjs` `loadEscalateInvestigations()` | If a message gets re-triaged later (under a newer prompt) and downgraded to severity 1, the older "escalate" investigation is suppressed in the rollup. Lets the agent self-correct without re-investigating. |

---

## Repo layout

```
db/schema.sql                    Tables + indexes (escalations, investigations, triage_runs,
                                 digest_deliveries, exec_feedback, watched_execs, etc.)
scripts/
├── ingest-slack-24h.mjs         Pull Slack channels via multi-token router
├── ingest-front.mjs             Pull Front via Snowflake (Frosty proxy)
├── slack-tick.mjs               Hourly: ingest + Tier A submit + investigate-flagged
├── front-tick.mjs               Hourly: ingest + Tier A submit + investigate
├── triage-batch.mjs             Tier A submit/poll via Anthropic Batch API
├── triage-front-batch.mjs       Same, for Front conversations
├── investigate-flagged.mjs      Tier B Sonnet investigations (Slack)
├── investigate-front.mjs        Tier B Sonnet investigations (Front)
├── roll-up-escalations.mjs      Cluster Slack investigations into escalations
├── roll-up-front-escalations.mjs Cluster Front investigations
├── send-digest.mjs              The delivery pipeline (rank → revalidate → balance → cap → DM)
├── digest-tick.mjs              Daily 5:30am orchestrator (rollup → backfill titles → send)
├── run-reflection.mjs           Tier C Opus reflection loop
├── apply-proposal.mjs           Apply an accepted Tier C proposal to active_criteria
├── feedback-listener.mjs        Slack Events listener for exec reactions/replies → exec_feedback
├── seed-watched-execs.mjs       Seed the digest recipient list (EDIT BEFORE RUNNING)
├── seed-active-criteria.mjs     Seed the seven default Tier A criteria
├── lib/
│   ├── triage-prompt.mjs        Dynamic Tier A prompt assembly + version hashing
│   ├── investigate.mjs          Tier B prompt + tool definitions + run loop
│   ├── investigation-tools.mjs  fetch_thread_replies, search_messages, lookup_employee, etc.
│   ├── reflect.mjs              Tier C prompt + proposal generation
│   ├── escalation-score.mjs     rankAndBalance scoring + per-source min
│   ├── digest-revalidate.mjs    Live Slack thread re-check before delivery
│   ├── slack-token-router.mjs   Multi-token routing + channel-membership cache
│   ├── slack-api.mjs            Slack REST wrapper (rate-limit aware)
│   ├── slack-write.mjs          chat.postMessage + DM IM channel resolution
│   ├── frosty-client.mjs        Snowflake proxy client
│   ├── front-role-fix.mjs       Repair role labels on Front turns where the curated
│   │                             pipeline mislabels ES employees as customer
│   ├── structural-filter.mjs    Pre-LLM silence rules (regex, channel, author)
│   ├── exec-feedback-context.mjs Renders recent exec feedback as prompt text
│   ├── escalation-title.mjs     Haiku-generated display titles + short summaries
│   ├── humans-only.mjs          Bot/automation account filter
│   ├── intervention-detector.mjs Detect when an exec has already engaged on a thread
│   └── db.mjs                   SQLite (better-sqlite3) + idempotent migrations
└── ...
.env.example                     Required + optional env vars
package.json                     npm scripts wrap most of the above (`npm run send:digest` etc.)
```

---

## Tech stack

- **Node.js 20+** with ES modules
- **better-sqlite3** for the local store. WAL mode. Single file at `data/escalation.db`. Schema at `db/schema.sql`. Idempotent column migrations in `scripts/lib/db.mjs` `applyMigrations()`.
- **@anthropic-ai/sdk** for Claude calls. Batch API for Tier A; live (with `betaZodTool` runner) for Tier B.
- **@slack/socket-mode** for the optional live event listener; otherwise plain REST via `node:fetch`.
- **zod** for tool-input schemas + structured-output validation.
- **launchd** (macOS) for scheduled ticks. See `~/Library/LaunchAgents/` plists for `slack-tick`, `front-tick`, `digest-tick`.

No web framework, no message queue, no Kafka. Single SQLite file is the entire state. This is intentional — small enough to fork, copy, and adapt without inheriting infrastructure decisions.

---

## Setup

1. **Install:** `npm install`
2. **Config:** `cp .env.example .env.local` and fill in real values. Anthropic key required; everything else depends on which sources you wire up.
3. **Schema bootstrap:** the SQLite DB is created automatically on first script run. `data/` is gitignored.
4. **Seed:**
   - `scripts/seed-watched-execs.mjs` — **edit the SEED list first** with your real Slack user IDs.
   - `scripts/seed-active-criteria.mjs` — seeds the seven default Tier A criteria. Reword or replace before your first triage run.
5. **First ingest:** `npm run ingest:slack-24h` (or the Front equivalent if you've wired Snowflake).
6. **First triage:** `npm run triage:batch -- submit` then `npm run triage:batch -- poll` after a few minutes.
7. **First investigation:** `npm run investigate -- --limit 20`.
8. **First rollup + digest:** `npm run rollup && npm run send:digest -- --recipient <your-name> --dry-run`.

If everything works in dry-run, drop `--dry-run` and the digest hits Slack DMs.

---

## Adapting for a different use case

Most of the value here is the *shape* of the pipeline, not the prompts. To adapt:

### Keep as-is
- The cascade structure (Haiku → Sonnet → Opus on flagged items only)
- The dynamic prompt assembly (`triage-prompt.mjs`)
- The digest-time revalidation pattern
- The customer-event-driven dedupe (rename "customer" if not relevant)
- The exec-feedback-as-ground-truth loop
- Multi-token routing if you have a private-channel access problem

### Rewrite for your domain
- **Tier A criteria** (`scripts/seed-active-criteria.mjs`). The default seven are calibrated for "internal organizational dysfunction at a construction-equipment company." Yours will be different.
- **Tier B prompt** (`scripts/lib/investigate.mjs`). The "GROUNDING REQUIREMENTS" section encodes lessons learned about workflow-channel base rates and unfounded systemic-pattern claims; the rest of the prompt is your domain.
- **Structural silence rules** (`scripts/lib/structural-filter.mjs` + `silence_rules` table). The auto-quote, intake-form, and service-inbox patterns are EquipmentShare-specific. You'll have your own equivalents.
- **Source connectors**. Slack is generic; Front-via-Snowflake is highly opinionated. Replace `scripts/ingest-front.mjs` with your data source.
- **Scoring weights** (`scripts/lib/escalation-score.mjs`). `CRITERION_WEIGHT` and dollar-magnitude regexes are domain-specific.

### What you'll absolutely have to figure out yourself
- Mapping your messaging surface to "customer turn" vs. "internal turn." The whole dedupe + service-inbox-only-customer-required logic depends on having that distinction.
- Identifying your workflow channels (the equivalent of `#stolen_equipment`). Tier A will over-flag them otherwise.
- The exec feedback loop only works if exec actually reacts. Without that, the agent never learns.

---

## Lessons learned (the painful ones)

These are the failure modes that cost trust, in rough order of severity:

1. **Tier B inferred "systemic patterns" from same-channel flag count.** Workflow channels have a base rate. Three theft reports in `#stolen_equipment` over four days is the channel doing its job, not a systemic problem. Fix: require explicit pattern language from humans, or cross-channel/cross-region evidence, or a senior person framing it as a pattern. Otherwise: independent events, treat as singletons.

2. **Tier B invented process gaps the messages didn't claim.** "Root cause: the off-rent trigger is too slow" — nobody in the thread said that. Tier B was theorizing. Fix: every causal claim in the exec_summary must be traceable to a human quote in the evidence. Stick to what was said.

3. **Stale "no reply" claims at delivery time.** Tier B flags an item as dead-air at noon; by 5:30 AM the next morning the thread has 17 replies and a recovery team is on-site. Without revalidation, the digest ships embarrassingly wrong claims. Fix: `digest-revalidate.mjs`. Single biggest trust-building change in the project.

4. **The "From: EquipmentShare" service-inbox pattern.** Service inboxes coordinate internal dispatch. A TAM emails the inbox to ask for a tech; archive without reply is the workflow. The customer never appears. Naive dead-air detection flags this every time. Fix: rollup filter for "service inbox + zero customer turns ever = workflow."

5. **Auto-mailed quote emails (SendGrid forwarder).** Front ingests them; the form structure looks personal because it has customer name + asset details; the customer never wrote a personal message; archive without reply is normal. Fix: structural silence rule on the SendGrid URL pattern + the "Customer Information / Asset Information / T3 Lookups" intake-form body structure, when standalone.

6. **Same item delivered every morning forever.** Initial dedupe was "delivered ever, never again." Long-pending issues showed up once and disappeared. The customer kept emailing and we never re-surfaced. Fix: `signal_event_at` per escalation, dedupe on `signal_event_at > last_delivered_at`.

7. **Digest going mono-source on a quiet day.** All Slack or all Front. Exec loses cross-surface awareness. Fix: source-min backfill that reaches into a wider lookback for the underrepresented source.

8. **Sev-5 items aging out of the 24h window.** A genuine sev-5 from a week ago disappeared. Fix: sev-floor backfill — always pull top-N sev-5 items from 30-day window, even if outside the fresh window.

9. **Rollup using the oldest classification of a re-triaged message.** The agent self-corrected on a message (later prompts classified it severity 1) but the rollup still used the original severity 4 flag. Fix: `loadEscalateInvestigations()` checks for newer triage runs on the same message; downgrades suppress the older investigation.

10. **Front timestamps not ISO.** Snowflake returns `"2026-05-01 11:30:48.594000+00:00"` (space separator). Slack stores ISO. SQLite string comparisons across the formats are silently wrong (`' ' < 'T'`). Fix: `toIsoTs()` helper applied at every Front write site + a one-time backfill.

---

## What this repo is NOT

- A SaaS product. Single-tenant, no multi-org isolation.
- A real-time alert system. The cadence is "daily morning digest, sometimes hourly during active investigation." If you need under-a-minute latency, redesign.
- A complete tool. The Front side requires a Snowflake-backed pipeline you have to wire up yourself; we don't ingest the Front REST API directly.
- Generic. The prompts are calibrated for one company. They WILL be wrong for yours until you rewrite them.

If you want any of those things, fork this and use it as scaffolding — the architectural patterns transfer; the surface-level code does not.

---

## License

MIT. See `LICENSE`.
