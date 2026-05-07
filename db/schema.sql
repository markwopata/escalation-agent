-- Escalation agent local schema (SQLite).
-- Designed to migrate cleanly to Postgres later: prefer portable types,
-- avoid SQLite-only quirks where possible, use TEXT timestamps in ISO-8601 UTC.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- =========================================================================
-- Identity: who is who
-- =========================================================================

-- All active EquipmentShare employees, corporate AND field.
-- Sourced from Snowflake people_analytics.workday_raas.company_directory_sensitive.
-- Re-synced periodically; rows are upserted by employee_id.
--
-- "Corporate" = default_cost_centers_full_path ilike 'Corp/Corp/Corporate/%'.
-- Everyone else = "Field". The flag `is_corporate` materializes that.
CREATE TABLE IF NOT EXISTS employees (
  employee_id                   TEXT PRIMARY KEY,
  full_name                     TEXT NOT NULL,
  first_name                    TEXT,
  last_name                     TEXT,
  employee_email                TEXT,                    -- Workday work_email (verbatim; format is NOT uniform)
  employee_status               TEXT,                    -- Active / On Leave / etc.
  worker_type                   TEXT,
  employee_type                 TEXT,
  employee_title                TEXT,

  -- Reporting line
  direct_manager_employee_id    TEXT,
  direct_manager_name           TEXT,

  -- Org structure (default_cost_centers_full_path split into levels)
  cost_center_path              TEXT,                    -- full path verbatim
  cost_center_level_1           TEXT,
  cost_center_level_2           TEXT,
  cost_center_level_3           TEXT,
  department_or_function        TEXT,                    -- level 4
  sub_department_or_team        TEXT,                    -- level 5
  is_corporate                  INTEGER NOT NULL DEFAULT 0,  -- materialized flag, 1 = Corporate, 0 = Field

  -- Geography / market
  location                      TEXT,
  market_id                     TEXT,
  employee_state                TEXT,                    -- ee_state in source
  tax_location                  TEXT,

  -- Pay (useful as a function/role signal beyond title)
  pay_group                     TEXT,
  pay_frequency                 TEXT,
  pay_calc                      TEXT,

  -- Dates / tenure
  date_hired                    TEXT,
  date_rehired                  TEXT,
  date_terminated               TEXT,
  position_effective_date       TEXT,
  job_last_changed              TEXT,
  tenure_days                   INTEGER,
  tenure_years                  REAL,

  synced_at                     TEXT NOT NULL            -- ISO-8601 UTC
);

CREATE INDEX IF NOT EXISTS idx_employees_email
  ON employees (employee_email);
CREATE INDEX IF NOT EXISTS idx_employees_is_corporate
  ON employees (is_corporate);
CREATE INDEX IF NOT EXISTS idx_employees_cost_center
  ON employees (cost_center_path);
CREATE INDEX IF NOT EXISTS idx_employees_department
  ON employees (department_or_function);
CREATE INDEX IF NOT EXISTS idx_employees_market
  ON employees (market_id);
CREATE INDEX IF NOT EXISTS idx_employees_manager
  ON employees (direct_manager_employee_id);

-- Slack users we have ever observed.
-- Populated from slack_search_users / slack_read_user_profile / message authorship.
-- Includes everyone we encounter — corporate, field, bots, externals.
CREATE TABLE IF NOT EXISTS slack_users (
  slack_user_id                 TEXT PRIMARY KEY,        -- e.g. U049CJZG5
  username                      TEXT,                    -- handle (no @)
  display_name                  TEXT,
  real_name                     TEXT,
  email                         TEXT,                    -- Slack profile email
  title                         TEXT,
  timezone                      TEXT,
  is_bot                        INTEGER NOT NULL DEFAULT 0,
  is_restricted                 INTEGER NOT NULL DEFAULT 0,
  is_deleted                    INTEGER NOT NULL DEFAULT 0,
  observed_at                   TEXT NOT NULL,
  profile_fetched_at            TEXT
);

CREATE INDEX IF NOT EXISTS idx_slack_users_email
  ON slack_users (email);
CREATE INDEX IF NOT EXISTS idx_slack_users_real_name
  ON slack_users (real_name);

-- The join: which Slack user is which Workday employee.
-- One row per attempted resolution. Unmatched rows are kept on purpose so
-- the gap is *visible* (e.g., an employee who isn't findable in Slack).
-- match_method records HOW we resolved the link, so we can re-evaluate
-- later when heuristics improve. manually_overridden=1 protects hand-fixes
-- from being clobbered by the next sync.
CREATE TABLE IF NOT EXISTS employee_slack_link (
  employee_id                   TEXT NOT NULL,
  slack_user_id                 TEXT,                    -- nullable: NULL = unmatched
  match_method                  TEXT NOT NULL,           -- 'email_exact' | 'name_then_email_confirm' | 'name_only' | 'manual' | 'unmatched' | ...
  match_confidence              TEXT NOT NULL,           -- 'high' | 'medium' | 'low' | 'none'
  match_notes                   TEXT,                    -- e.g. "2 candidates, picked by email match"
  manually_overridden           INTEGER NOT NULL DEFAULT 0,
  resolved_at                   TEXT NOT NULL,
  PRIMARY KEY (employee_id),
  FOREIGN KEY (employee_id)    REFERENCES employees (employee_id) ON DELETE CASCADE,
  FOREIGN KEY (slack_user_id)  REFERENCES slack_users (slack_user_id)
);

CREATE INDEX IF NOT EXISTS idx_link_slack_user
  ON employee_slack_link (slack_user_id);
CREATE INDEX IF NOT EXISTS idx_link_method
  ON employee_slack_link (match_method);

-- Convenience view: every employee with their resolved Slack identity (if any).
-- This is the table downstream pipeline code will join against to answer
-- "who authored this Slack message and what's their org context?".
DROP VIEW IF EXISTS v_employees_with_slack;
CREATE VIEW v_employees_with_slack AS
SELECT
  e.employee_id,
  e.full_name,
  e.first_name,
  e.last_name,
  e.employee_email,
  e.employee_title,
  e.is_corporate,
  e.cost_center_path,
  e.department_or_function,
  e.sub_department_or_team,
  e.direct_manager_name,
  e.direct_manager_employee_id,
  e.location,
  e.market_id,
  e.employee_state,
  e.tenure_years,
  link.slack_user_id,
  link.match_method,
  link.match_confidence,
  su.username      AS slack_username,
  su.display_name  AS slack_display_name,
  su.email         AS slack_email,
  su.is_bot        AS slack_is_bot
FROM employees e
LEFT JOIN employee_slack_link link ON link.employee_id = e.employee_id
LEFT JOIN slack_users su ON su.slack_user_id = link.slack_user_id;

-- =========================================================================
-- Slack content
-- =========================================================================

-- Slack channels we ingest from. The naming-convention parse fields
-- (priority_tier, segment_code, customer_slug, project_status) are best-effort
-- — they're populated when the channel name matches the EquipmentShare
-- per-project pattern (e.g. 1dc-vantagewisconsin-m-020). Other channels leave
-- these NULL and are still ingested.
CREATE TABLE IF NOT EXISTS channels (
  slack_channel_id              TEXT PRIMARY KEY,        -- e.g. C09LB9JF2TD
  name                          TEXT NOT NULL,
  channel_type                  TEXT,                    -- 'public_channel' | 'private_channel' | 'im' | 'mpim'
  is_archived                   INTEGER NOT NULL DEFAULT 0,
  topic                         TEXT,
  purpose                       TEXT,
  creator_user_id               TEXT,
  created_ts                    TEXT,                    -- channel creation timestamp
  -- Parsed from EquipmentShare naming convention when applicable:
  priority_tier                 INTEGER,                 -- 1, 2, 3 from prefix
  segment_code                  TEXT,                    -- 'dc', 'ind', 'co', 'cm'
  customer_slug                 TEXT,                    -- middle segment (e.g. 'vantagewisconsin')
  project_status                TEXT,                    -- single letter: 'm', 'c', 'o', 'x'
  project_number                TEXT,                    -- trailing 2-3 digit number
  -- Polling controls:
  ingestion_priority            TEXT NOT NULL DEFAULT 'normal',  -- 'high' | 'normal' | 'low'
  last_ingested_at              TEXT,
  -- Bookkeeping:
  first_seen_at                 TEXT NOT NULL,
  last_seen_at                  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_channels_name
  ON channels (name);
CREATE INDEX IF NOT EXISTS idx_channels_segment
  ON channels (segment_code);
CREATE INDEX IF NOT EXISTS idx_channels_priority
  ON channels (ingestion_priority);

-- Every Slack message we capture. Top-level messages and thread replies both
-- live here; thread_ts identifies the parent (and equals slack_ts for parents).
-- raw_payload retains the full Slack JSON so we can reprocess if we discover
-- we need a field we didn't extract. Treated as immutable: triage and
-- investigation outputs go in derived tables, never overwriting messages.
CREATE TABLE IF NOT EXISTS messages (
  slack_channel_id              TEXT NOT NULL,
  slack_ts                      TEXT NOT NULL,           -- Slack's message timestamp / ID
  thread_ts                     TEXT,                    -- parent ts; NULL or = slack_ts for top-level
  author_slack_user_id          TEXT,                    -- nullable for system / bot / unknown
  author_username               TEXT,                    -- snapshot from message envelope
  text                          TEXT,
  message_type                  TEXT,                    -- 'message' | 'message_changed' | 'message_deleted' | ...
  subtype                       TEXT,                    -- 'bot_message', 'channel_join', etc.
  is_bot                        INTEGER NOT NULL DEFAULT 0,
  reactions_json                TEXT,                    -- JSON array of {name, count, users}
  mentions_user_ids_json        TEXT,                    -- JSON array of mentioned user_ids parsed from text
  has_files                     INTEGER NOT NULL DEFAULT 0,
  has_links                     INTEGER NOT NULL DEFAULT 0,
  reply_count                   INTEGER,                 -- from parent message envelope
  edited_at_ts                  TEXT,
  deleted                       INTEGER NOT NULL DEFAULT 0,
  raw_payload                   TEXT NOT NULL,           -- full Slack message JSON
  message_posted_at             TEXT,                    -- ISO-8601 derived from slack_ts
  ingested_at                   TEXT NOT NULL,
  PRIMARY KEY (slack_channel_id, slack_ts),
  FOREIGN KEY (slack_channel_id) REFERENCES channels (slack_channel_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_thread
  ON messages (slack_channel_id, thread_ts);
CREATE INDEX IF NOT EXISTS idx_messages_author
  ON messages (author_slack_user_id);
CREATE INDEX IF NOT EXISTS idx_messages_posted_at
  ON messages (message_posted_at);

-- =========================================================================
-- Triage: cheap-LLM first-pass evaluation of every message.
-- Each row is one Haiku evaluation of one message under one prompt version.
-- Re-running with a new prompt_version creates a new row; older runs are
-- preserved as audit history.
-- =========================================================================
CREATE TABLE IF NOT EXISTS triage_runs (
  id                            INTEGER PRIMARY KEY AUTOINCREMENT,
  slack_channel_id              TEXT NOT NULL,
  slack_ts                      TEXT NOT NULL,
  model                         TEXT NOT NULL,           -- e.g. 'claude-haiku-4-5'
  prompt_version                TEXT NOT NULL,           -- e.g. 'triage-v1'
  worth_deeper_look             INTEGER NOT NULL,        -- 0 or 1
  severity                      INTEGER,                 -- 1-5 from Haiku
  primary_criterion             TEXT,                    -- one of the 7 categories or NULL
  criteria_matched_json         TEXT,                    -- JSON array of matched criteria
  reason                        TEXT NOT NULL,           -- short explanation from Haiku
  full_response_json            TEXT,                    -- full structured output for audit
  input_tokens                  INTEGER,
  output_tokens                 INTEGER,
  cache_read_input_tokens       INTEGER,
  cache_creation_input_tokens   INTEGER,
  ran_at                        TEXT NOT NULL,
  duration_ms                   INTEGER,
  FOREIGN KEY (slack_channel_id, slack_ts) REFERENCES messages (slack_channel_id, slack_ts) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_triage_one_per_version
  ON triage_runs (slack_channel_id, slack_ts, prompt_version);
CREATE INDEX IF NOT EXISTS idx_triage_worth_deeper
  ON triage_runs (worth_deeper_look, severity);
CREATE INDEX IF NOT EXISTS idx_triage_primary_criterion
  ON triage_runs (primary_criterion);

-- =========================================================================
-- Investigation: Tier B deeper analysis on flagged triage items.
-- Sonnet (or equivalent) gets the flagged message + tools to dig deeper
-- (fetch_thread, search_messages, lookup_employee, etc.) and produces a
-- structured decision: escalate to exec / monitor / dismiss.
-- =========================================================================
CREATE TABLE IF NOT EXISTS investigations (
  id                            INTEGER PRIMARY KEY AUTOINCREMENT,
  triage_run_id                 INTEGER NOT NULL,
  model                         TEXT NOT NULL,
  prompt_version                TEXT NOT NULL,
  decision                      TEXT NOT NULL,           -- 'escalate' | 'monitor' | 'dismiss'
  severity                      INTEGER,                 -- post-investigation severity 1-5
  exec_summary                  TEXT NOT NULL,           -- one-paragraph summary for the exec
  rationale                     TEXT NOT NULL,           -- longer reasoning trail
  evidence_refs_json            TEXT,                    -- {channel_ids:[], message_ts:[], employee_ids:[]}
  recommended_actions_json      TEXT,                    -- list of suggested next actions for the exec
  tools_used_json               TEXT,                    -- {tool_name: call_count}
  full_response_json            TEXT,
  input_tokens                  INTEGER,
  output_tokens                 INTEGER,
  cache_read_input_tokens       INTEGER,
  cache_creation_input_tokens   INTEGER,
  ran_at                        TEXT NOT NULL,
  duration_ms                   INTEGER,
  FOREIGN KEY (triage_run_id) REFERENCES triage_runs (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_investigation_one_per_version
  ON investigations (triage_run_id, prompt_version);
CREATE INDEX IF NOT EXISTS idx_investigation_decision
  ON investigations (decision, severity);

-- =========================================================================
-- Escalations: deduplicated, exec-ready output.
-- One row per *underlying issue* (cluster of related investigations), not one
-- per investigation. Many Sonnet investigations of the same author or same
-- channel-criterion fold into one escalation here.
--
-- exec_action carries the human feedback loop that will eventually train the
-- agent's calibration ('false positive', 'fixed', 'in progress', etc.).
-- =========================================================================
CREATE TABLE IF NOT EXISTS escalations (
  id                                  INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_key                         TEXT NOT NULL,            -- stable identifier within a rollup_version
  rollup_version                      TEXT NOT NULL,            -- e.g. 'rollup-v1'
  cluster_type                        TEXT NOT NULL,            -- 'author' | 'channel_criterion' | 'singleton'
  author_slack_user_id                TEXT,                     -- if cluster is by-author
  slack_channel_id                    TEXT,                     -- if cluster is by-channel
  primary_criterion                   TEXT,
  criteria_observed_json              TEXT,                     -- JSON array of all criteria seen across cluster
  max_severity                        INTEGER NOT NULL,
  evidence_investigation_ids_json     TEXT NOT NULL,            -- JSON array of investigation.id values
  evidence_message_count              INTEGER NOT NULL,
  representative_investigation_id     INTEGER,
  representative_exec_summary         TEXT NOT NULL,
  representative_recommended_actions_json TEXT,
  first_evidence_at                   TEXT,                     -- earliest message time in cluster
  last_evidence_at                    TEXT,                     -- latest message time in cluster
  created_at                          TEXT NOT NULL,
  -- Exec feedback loop:
  exec_action                         TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'acknowledged' | 'in_progress' | 'fixed' | 'dismissed' | 'monitor_only'
  exec_action_at                      TEXT,
  exec_notes                          TEXT,
  -- Short human-readable title used as the digest message headline
  -- (e.g., "Apex Hubbard light plant shortfall"). Generated by Haiku at
  -- rollup time. NULL until the title-backfill runs.
  display_title                       TEXT,
  display_title_short_summary         TEXT,                              -- 1-sentence summary derived for the digest headline
  -- Most recent material customer event timestamp. Used by the digest dedupe
  -- to decide whether an already-delivered escalation should re-surface (a
  -- new customer follow-up arrived). Front: MAX(front_messages.created_at
  -- WHERE role='customer'). Slack: MAX(messages.message_posted_at). Written
  -- by the rollup scripts.
  signal_event_at                     TEXT,
  FOREIGN KEY (representative_investigation_id) REFERENCES investigations (id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_escalations_cluster
  ON escalations (rollup_version, cluster_key);
CREATE INDEX IF NOT EXISTS idx_escalations_pending
  ON escalations (exec_action, max_severity);
CREATE INDEX IF NOT EXISTS idx_escalations_author
  ON escalations (author_slack_user_id);

-- =========================================================================
-- Exec feedback: continuous free-text input from the audience.
--
-- The agent gets smarter ONLY if exec feedback flows back in. This table
-- captures every signal — accept/dismiss decisions on individual escalations,
-- general-direction guidance ("focus more on equipment-down events"), and
-- responses to Tier C's proposed criteria.
--
-- The triage and investigation prompts both read the most recent N entries
-- as additional context so behavior shifts in near-real-time.
--
-- target_type values:
--   'escalation'         — feedback on a specific escalations.id row
--   'criterion_proposal' — feedback on a Tier C proposal (criterion_proposals.id)
--   'general'            — free-text guidance not tied to a specific item
-- =========================================================================
CREATE TABLE IF NOT EXISTS exec_feedback (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  exec_name                TEXT,                     -- free text; can be email or display name
  target_type              TEXT NOT NULL,            -- 'escalation' | 'criterion_proposal' | 'general'
  target_id                INTEGER,                  -- escalations.id or criterion_proposals.id when applicable
  feedback_text            TEXT NOT NULL,            -- the free-text body (the load-bearing field)
  sentiment                TEXT,                     -- 'useful' | 'not_useful' | 'noise' | 'wrong_severity' | 'praise' | 'other' | null
  tags_json                TEXT,                     -- optional JSON array of theme tags
  created_at               TEXT NOT NULL,
  processed_by_tier_c_at   TEXT                      -- when Tier C last consumed this feedback
);

CREATE INDEX IF NOT EXISTS idx_exec_feedback_target
  ON exec_feedback (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_exec_feedback_recent
  ON exec_feedback (created_at);
CREATE INDEX IF NOT EXISTS idx_exec_feedback_unprocessed
  ON exec_feedback (processed_by_tier_c_at);

-- =========================================================================
-- Tier C: weekly reflection. Opus reads recent escalations + exec feedback
-- and proposes new escalation criteria, criterion edits, or calibration
-- shifts. Each proposal is reviewed by the exec (via exec_feedback) before
-- being adopted.
-- =========================================================================
CREATE TABLE IF NOT EXISTS criterion_proposals (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  reflection_run_id        INTEGER,                  -- references reflection_runs.id
  proposal_type            TEXT NOT NULL,            -- 'new_criterion' | 'edit_criterion' | 'calibration_shift' | 'silence_pattern'
  proposed_change          TEXT NOT NULL,            -- the actual proposal as a plain-English description
  rationale                TEXT NOT NULL,            -- why Opus proposed this
  evidence_json            TEXT,                     -- JSON: {escalation_ids:[], feedback_ids:[]}
  status                   TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'accepted' | 'rejected' | 'modified'
  created_at               TEXT NOT NULL,
  decided_at               TEXT,
  decided_by               TEXT
);

CREATE INDEX IF NOT EXISTS idx_proposals_status ON criterion_proposals (status);

-- =========================================================================
-- Reflection runs: each Tier C invocation gets logged with cost + summary.
-- =========================================================================
CREATE TABLE IF NOT EXISTS reflection_runs (
  id                            INTEGER PRIMARY KEY AUTOINCREMENT,
  model                         TEXT NOT NULL,
  prompt_version                TEXT NOT NULL,
  window_start                  TEXT NOT NULL,           -- start of the window analyzed
  window_end                    TEXT NOT NULL,
  escalations_analyzed          INTEGER NOT NULL,
  feedback_analyzed             INTEGER NOT NULL,
  proposals_emitted             INTEGER NOT NULL,
  summary_text                  TEXT,                    -- exec-readable summary of the reflection
  full_response_json            TEXT,
  input_tokens                  INTEGER,
  output_tokens                 INTEGER,
  cache_read_input_tokens       INTEGER,
  cache_creation_input_tokens   INTEGER,
  ran_at                        TEXT NOT NULL,
  duration_ms                   INTEGER
);

-- =========================================================================
-- Entity extraction: structured pulls from each message at ingest time.
-- Bridges un-threaded re-emergence by exact match — "all messages mentioning
-- account #106396" becomes a SQL query, not a text search.
-- =========================================================================
CREATE TABLE IF NOT EXISTS message_entities (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  slack_channel_id       TEXT NOT NULL,
  slack_ts               TEXT NOT NULL,
  entity_type            TEXT NOT NULL,         -- 'asset_id' | 'work_order' | 'account_number' | 'customer_name' | 'serial_number' | 'phone' | 'wo_status' | 'workflow_term'
  entity_value           TEXT NOT NULL,         -- normalized value (e.g., '106396' not 'account #106396')
  raw_match             TEXT,                   -- the raw substring from the message
  extraction_method     TEXT NOT NULL,         -- 'regex' | 'llm' | 'manual'
  extracted_at          TEXT NOT NULL,
  FOREIGN KEY (slack_channel_id, slack_ts) REFERENCES messages (slack_channel_id, slack_ts) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_entities_lookup ON message_entities (entity_type, entity_value);
CREATE INDEX IF NOT EXISTS idx_entities_message ON message_entities (slack_channel_id, slack_ts);

-- =========================================================================
-- Non-human authors: Slack user_ids whose messages we always discard at
-- ingest. Includes bots that post as users (AI chatbots like Arnold,
-- workflow bots), Slackbot itself (USLACKBOT), and anything else the
-- exec marks as non-signal.
--
-- This is the authoritative "humans only" list. Add via INSERT or via the
-- record-non-human-author CLI.
-- =========================================================================
CREATE TABLE IF NOT EXISTS non_human_authors (
  slack_user_id   TEXT PRIMARY KEY,
  display_name    TEXT,
  reason          TEXT,                 -- why excluded (e.g. 'AI chatbot', 'workflow bot', 'Slackbot')
  added_at        TEXT NOT NULL,
  added_by        TEXT
);

CREATE INDEX IF NOT EXISTS idx_non_human_authors_added ON non_human_authors (added_at);

-- =========================================================================
-- Watched execs: people whose interventions count as ground-truth signal.
-- The CEO's @-mentions or unprompted entries into a public thread are gold —
-- they tell us what the highest-level audience ACTUALLY cares about, not
-- what the static criteria predict they should care about.
--
-- Seed with the audience execs (CEO, President, etc). Add or remove via
-- direct INSERT/DELETE; the detector reads this table at runtime.
-- =========================================================================
CREATE TABLE IF NOT EXISTS watched_execs (
  employee_id        TEXT PRIMARY KEY,
  slack_user_id      TEXT,                  -- nullable until resolved
  display_name       TEXT NOT NULL,         -- e.g. 'Jane Doe'
  exec_role          TEXT NOT NULL,         -- e.g. 'CEO', 'President'
  active             INTEGER NOT NULL DEFAULT 1,
  added_at           TEXT NOT NULL,
  notes              TEXT
);

CREATE INDEX IF NOT EXISTS idx_watched_execs_slack ON watched_execs (slack_user_id);
CREATE INDEX IF NOT EXISTS idx_watched_execs_active ON watched_execs (active);

-- =========================================================================
-- CEO / exec interventions: every time a watched exec authors a message,
-- gets @-mentioned, or otherwise touches a public thread, we capture it
-- here. Tier C reads this alongside exec_feedback as a second source of
-- ground-truth signal — and Tier A can eventually use it to bias toward
-- channels/threads the exec has touched recently.
-- =========================================================================
CREATE TABLE IF NOT EXISTS ceo_interventions (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  exec_employee_id            TEXT NOT NULL,         -- watched_execs.employee_id
  exec_slack_user_id          TEXT,                  -- snapshot
  exec_display_name           TEXT NOT NULL,         -- snapshot
  intervention_type           TEXT NOT NULL,         -- 'authored' | 'mentioned' | 'reacted' | 'joined_channel'
  slack_channel_id            TEXT NOT NULL,
  slack_ts                    TEXT NOT NULL,         -- ts of the message tied to the intervention
  thread_ts                   TEXT,                  -- if the message is in a thread
  authored_by_slack_user_id   TEXT,                  -- who wrote the message (relevant when type=mentioned)
  evidence_text               TEXT,                  -- short preview of the message body for context
  intervention_at             TEXT NOT NULL,         -- ISO timestamp of the intervening message
  detected_at                 TEXT NOT NULL,
  notes                       TEXT,
  FOREIGN KEY (exec_employee_id) REFERENCES watched_execs (employee_id) ON DELETE CASCADE,
  FOREIGN KEY (slack_channel_id, slack_ts) REFERENCES messages (slack_channel_id, slack_ts) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_interventions_unique
  ON ceo_interventions (exec_employee_id, intervention_type, slack_channel_id, slack_ts);
CREATE INDEX IF NOT EXISTS idx_interventions_recent
  ON ceo_interventions (intervention_at);
CREATE INDEX IF NOT EXISTS idx_interventions_channel
  ON ceo_interventions (slack_channel_id);

-- =========================================================================
-- Digest deliveries: tracks every Slack DM the bot has sent to an exec,
-- mapping the bot's message_ts back to the escalation_id it delivered.
-- This is THE bridge that lets the feedback listener turn a reaction or
-- thread reply on a Slack message into an exec_feedback row pointing at
-- the right escalation.
--
-- Idempotent: unique on (recipient, escalation) so we never re-deliver
-- the same escalation to the same person twice.
-- =========================================================================
CREATE TABLE IF NOT EXISTS digest_deliveries (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  exec_employee_id         TEXT NOT NULL,
  recipient_slack_user_id  TEXT NOT NULL,
  escalation_id            INTEGER NOT NULL,
  bot_message_channel      TEXT NOT NULL,           -- IM channel ID returned by conversations.open
  bot_message_ts           TEXT NOT NULL,           -- ts of the message we posted
  delivered_at             TEXT NOT NULL,
  delivery_method          TEXT NOT NULL DEFAULT 'bot_dm',  -- 'bot_dm' | 'user_dm' (path-A fallback) | 'channel_post'
  FOREIGN KEY (exec_employee_id) REFERENCES watched_execs (employee_id),
  FOREIGN KEY (escalation_id) REFERENCES escalations (id) ON DELETE CASCADE
);

-- Note: previously had a UNIQUE(recipient_slack_user_id, escalation_id) index;
-- dropped via migration. Multiple deliveries of the same escalation to the
-- same recipient are valid — they happen when a new customer follow-up
-- arrives, making the escalation exec-relevant again. Audit > insert-or-ignore.
CREATE INDEX IF NOT EXISTS idx_digest_deliveries_recipient_escalation
  ON digest_deliveries (recipient_slack_user_id, escalation_id, delivered_at);
CREATE INDEX IF NOT EXISTS idx_digest_deliveries_message
  ON digest_deliveries (bot_message_channel, bot_message_ts);
CREATE INDEX IF NOT EXISTS idx_digest_deliveries_recipient
  ON digest_deliveries (recipient_slack_user_id);

-- =========================================================================
-- Batch jobs: tracks Anthropic Batch API submissions for the overnight
-- pipeline. submit step writes a row, poll step reads + clears.
-- =========================================================================
CREATE TABLE IF NOT EXISTS batch_jobs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id          TEXT NOT NULL UNIQUE,            -- Anthropic batch_id
  job_type          TEXT NOT NULL,                   -- 'triage' | 'investigate'
  prompt_version    TEXT NOT NULL,
  request_count     INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'submitted', -- 'submitted' | 'ended' | 'cancelled' | 'persisted'
  submitted_at      TEXT NOT NULL,
  ended_at          TEXT,
  persisted_at      TEXT,
  custom_id_map_json TEXT                           -- JSON: { custom_id -> { slack_channel_id, slack_ts } }
);

CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON batch_jobs (status);

-- =========================================================================
-- Active criteria — the live escalation-criteria set, stored as DATA, not
-- embedded in the Tier A system prompt. The triage prompt is built from
-- this table at runtime so accepted Tier C proposals take effect without
-- any code edit.
--
-- Seeded with the original seven criteria; new ones get added via
-- apply-proposal.mjs when a watched exec accepts a Tier C new_criterion
-- proposal.
-- =========================================================================
CREATE TABLE IF NOT EXISTS active_criteria (
  code                  TEXT PRIMARY KEY,             -- e.g. 'corporate_obstructing_field'
  name                  TEXT NOT NULL,                -- short human label for the digest
  description           TEXT NOT NULL,                -- full multi-paragraph spec for the prompt
  default_severity      INTEGER,                      -- if the criterion implies a default sev
  examples              TEXT,                         -- optional inline examples appended after the description
  active                INTEGER NOT NULL DEFAULT 1,
  source                TEXT NOT NULL DEFAULT 'seed', -- 'seed' | 'proposal:N'
  created_at            TEXT NOT NULL,
  modified_at           TEXT NOT NULL,
  modified_by           TEXT
);

CREATE INDEX IF NOT EXISTS idx_active_criteria_active ON active_criteria (active);

-- =========================================================================
-- Prompt overrides — exec calibration adjustments appended to the Tier A
-- system prompt as additional guidance. Each row is a free-text snippet
-- ("In #1dc-* channels, down-weight routine fleet allocation status...")
-- coming from an accepted calibration_shift proposal.
-- =========================================================================
CREATE TABLE IF NOT EXISTS prompt_overrides (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  override_text   TEXT NOT NULL,
  rationale       TEXT,                       -- why this exists (links back to the source proposal)
  active          INTEGER NOT NULL DEFAULT 1,
  source          TEXT NOT NULL DEFAULT 'seed',
  created_at      TEXT NOT NULL,
  applied_by      TEXT
);

CREATE INDEX IF NOT EXISTS idx_prompt_overrides_active ON prompt_overrides (active);

-- =========================================================================
-- Silence rules — dynamic structural-filter additions. Each row says
-- "skip messages where field X matches pattern Y." The structural filter
-- evaluates these at ingest time IN ADDITION to the always-on hardcoded
-- rules (channel_join, bot_message, etc.).
--
-- Most rules will be of type 'text_regex' (regex on message text), but
-- 'author_in_list' and 'subtype_match' are also supported.
-- =========================================================================
CREATE TABLE IF NOT EXISTS silence_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_type       TEXT NOT NULL,              -- 'text_regex' | 'subtype_match' | 'author_in_list' | 'channel_specific_text_regex'
  pattern         TEXT NOT NULL,              -- the regex / subtype value / list of slack_user_ids (JSON) / etc.
  scope_channel_id TEXT,                      -- if rule only applies to a specific channel
  reason          TEXT NOT NULL,              -- human-readable why
  active          INTEGER NOT NULL DEFAULT 1,
  source          TEXT NOT NULL DEFAULT 'seed',
  created_at      TEXT NOT NULL,
  applied_by      TEXT
);

CREATE INDEX IF NOT EXISTS idx_silence_rules_active ON silence_rules (active);

-- =========================================================================
-- Proposal deliveries — same shape as digest_deliveries but for criterion
-- proposals (Tier C output). Maps the Slack message_ts of the proposal DM
-- back to the criterion_proposals.id so reactions can trigger apply.
-- =========================================================================
CREATE TABLE IF NOT EXISTS proposal_deliveries (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  exec_employee_id         TEXT NOT NULL,
  recipient_slack_user_id  TEXT NOT NULL,
  proposal_id              INTEGER NOT NULL,
  bot_message_channel      TEXT NOT NULL,
  bot_message_ts           TEXT NOT NULL,
  delivered_at             TEXT NOT NULL,
  FOREIGN KEY (proposal_id) REFERENCES criterion_proposals (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_deliveries_unique
  ON proposal_deliveries (recipient_slack_user_id, proposal_id);
CREATE INDEX IF NOT EXISTS idx_proposal_deliveries_message
  ON proposal_deliveries (bot_message_channel, bot_message_ts);

-- =========================================================================
-- Future tables (NOT created yet — sketched here as a north star).
--
-- pattern_clusters(cluster_id, theme, exemplar_messages JSON, branches JSON,
--                  first_seen_at, last_seen_at)
-- =========================================================================

-- =========================================================================
-- Front (customer email/chat) ingestion.
--
-- Snowflake's PEOPLE_ANALYTICS.FRONT_ESCALATION schema is the system of
-- record. We persist a thin local mirror: just enough to triage and
-- retrieve cross-conversation context. Full message bodies stay in
-- Snowflake — we hydrate them on demand for Tier B/C.
--
-- Unit of work for Front is the CONVERSATION (not the message), unlike
-- Slack. A conversation triage looks at the full thread.
-- =========================================================================

CREATE TABLE IF NOT EXISTS front_inboxes (
  inbox_id            TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  inbox_kind          TEXT,                  -- 'customer-facing' | 'back-office' | 'branch-sales' | 'branch-service' | 'branch-parts' | 'legal' | 'workflow-bot' | 'unknown'
  triage_enabled      INTEGER NOT NULL DEFAULT 1,
  silence_reason      TEXT,                  -- if triage_enabled=0, why
  ingested_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_front_inboxes_kind ON front_inboxes (inbox_kind);
CREATE INDEX IF NOT EXISTS idx_front_inboxes_active ON front_inboxes (triage_enabled);

CREATE TABLE IF NOT EXISTS front_conversations (
  conversation_id          TEXT PRIMARY KEY,
  inbox_id                 TEXT NOT NULL,
  inbox_name               TEXT NOT NULL,           -- snapshot
  subject                  TEXT,
  current_status           TEXT,                    -- 'archive' | 'unassigned' | 'assign' | etc.
  current_teammate_id      TEXT,
  recipient_handle         TEXT,                    -- customer email
  recipient_role           TEXT,
  conversation_created_at  TEXT NOT NULL,           -- ISO
  first_inbound_at         TEXT,
  first_outbound_at        TEXT,
  minutes_to_first_reply   INTEGER,                 -- negative = ES sent first; null = never replied
  last_message_at          TEXT,
  total_message_count      INTEGER,
  inbound_message_count    INTEGER,
  outbound_message_count   INTEGER,
  ingested_at              TEXT NOT NULL,
  FOREIGN KEY (inbox_id) REFERENCES front_inboxes (inbox_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_front_conv_inbox      ON front_conversations (inbox_id);
CREATE INDEX IF NOT EXISTS idx_front_conv_created    ON front_conversations (conversation_created_at);
CREATE INDEX IF NOT EXISTS idx_front_conv_status     ON front_conversations (current_status);
CREATE INDEX IF NOT EXISTS idx_front_conv_no_reply   ON front_conversations (minutes_to_first_reply);

CREATE TABLE IF NOT EXISTS front_messages (
  message_id          TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL,
  turn_index          INTEGER NOT NULL,           -- 1-based, ordered
  role                TEXT NOT NULL,              -- 'customer' | 'es_employee' (post-role-fix)
  raw_role            TEXT,                       -- as labeled by warehouse before our fix
  author_id           TEXT,
  created_at          TEXT NOT NULL,
  text                TEXT,                       -- full message body
  ingested_at         TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES front_conversations (conversation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_front_msg_conv  ON front_messages (conversation_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_front_msg_role  ON front_messages (conversation_id, role);

-- Triage runs for Front (parallel to Slack triage_runs). Kept separate
-- for the proof so we don't refactor Slack-tuned code paths; we'll
-- converge later if desired.
CREATE TABLE IF NOT EXISTS front_triage_runs (
  id                              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id                 TEXT NOT NULL,
  inbox_id                        TEXT NOT NULL,
  model                           TEXT NOT NULL,
  prompt_version                  TEXT NOT NULL,
  worth_deeper_look               INTEGER NOT NULL,
  severity                        INTEGER NOT NULL,
  primary_criterion               TEXT NOT NULL,
  criteria_matched_json           TEXT NOT NULL,
  reason                          TEXT NOT NULL,
  full_response_json              TEXT,
  input_tokens                    INTEGER,
  output_tokens                   INTEGER,
  cache_read_input_tokens         INTEGER,
  cache_creation_input_tokens     INTEGER,
  ran_at                          TEXT NOT NULL,
  duration_ms                     INTEGER,
  UNIQUE (conversation_id, prompt_version),
  FOREIGN KEY (conversation_id) REFERENCES front_conversations (conversation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_front_triage_worth   ON front_triage_runs (worth_deeper_look);
CREATE INDEX IF NOT EXISTS idx_front_triage_sev     ON front_triage_runs (severity);
CREATE INDEX IF NOT EXISTS idx_front_triage_conv    ON front_triage_runs (conversation_id);

-- =========================================================================
-- Multi-token Slack access tracking. Each row records whether a given
-- token-owning user (Mark, Jabbok, Will, ...) has membership access to a
-- given Slack channel. Used to:
--   1. Route conversations.history calls to a token that has access.
--   2. Filter the per-recipient digest so each exec only sees flags
--      from channels they themselves can see.
--
-- Populated by slack-token-router.mjs at the start of each ingest run.
-- =========================================================================
CREATE TABLE IF NOT EXISTS channel_token_access (
  slack_channel_id        TEXT NOT NULL,
  token_owner_name        TEXT NOT NULL,        -- 'mark' | 'jabbok' | 'willy' | ...
  token_owner_slack_id    TEXT,                 -- snapshot of users.info.user_id at routing time
  is_member               INTEGER NOT NULL,     -- 1 if this owner can read the channel, else 0
  refreshed_at            TEXT NOT NULL,
  PRIMARY KEY (slack_channel_id, token_owner_name),
  FOREIGN KEY (slack_channel_id) REFERENCES channels (slack_channel_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cta_owner ON channel_token_access (token_owner_name, is_member);
CREATE INDEX IF NOT EXISTS idx_cta_channel ON channel_token_access (slack_channel_id);

-- =========================================================================
-- Front Tier B (Sonnet investigation on a flagged Front conversation).
-- One row per investigated conversation. Mirror of investigations table
-- but keyed on front_triage_runs instead of triage_runs.
-- =========================================================================
CREATE TABLE IF NOT EXISTS front_investigations (
  id                              INTEGER PRIMARY KEY AUTOINCREMENT,
  front_triage_run_id             INTEGER NOT NULL,
  conversation_id                 TEXT NOT NULL,
  inbox_id                        TEXT NOT NULL,
  model                           TEXT NOT NULL,
  prompt_version                  TEXT NOT NULL,
  decision                        TEXT NOT NULL,         -- 'escalate' | 'monitor' | 'dismiss'
  severity                        INTEGER NOT NULL,
  exec_summary                    TEXT NOT NULL,
  rationale                       TEXT,
  recommended_actions_json        TEXT,
  full_response_json              TEXT,
  input_tokens                    INTEGER,
  output_tokens                   INTEGER,
  cache_read_input_tokens         INTEGER,
  cache_creation_input_tokens     INTEGER,
  ran_at                          TEXT NOT NULL,
  duration_ms                     INTEGER,
  UNIQUE (front_triage_run_id, prompt_version),
  FOREIGN KEY (front_triage_run_id) REFERENCES front_triage_runs (id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES front_conversations (conversation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_front_inv_decision ON front_investigations (decision);
CREATE INDEX IF NOT EXISTS idx_front_inv_conv ON front_investigations (conversation_id);
