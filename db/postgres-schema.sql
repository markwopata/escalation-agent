-- Postgres + pgvector schema for the escalation agent. Mirrors
-- db/schema.sql with portable types and adds halfvec embedding columns
-- for hybrid retrieval at scale.
--
-- DO NOT APPLY UNTIL we cross ~500K messages or hit a sqlite-vec wall.
-- For now this exists as the migration target.
--
-- Setup (when ready):
--   1. createdb escalation
--   2. psql escalation -c "CREATE EXTENSION vector;"
--   3. (Optional) ParadeDB pg_search for true BM25:
--        CREATE EXTENSION pg_search;
--      Otherwise built-in tsvector full-text is fine to start.
--   4. psql escalation -f db/postgres-schema.sql
--   5. Run scripts/migrate-sqlite-to-postgres.mjs (TODO — straightforward
--      pgloader equivalent on these tables)
--
-- Notes on storage at 1M messages, 200K threads:
--   - Per-message text + metadata: ~1 GB
--   - Per-thread embeddings (halfvec(512)): ~200K * 512 * 2 bytes = ~200 MB
--   - HNSW overhead: +50% on the vector size
--   - FTS index: ~200-400 MB
--   Total: comfortable for a single Postgres box up to 5-10M rows.

CREATE EXTENSION IF NOT EXISTS vector;

-- =========================================================================
-- IDENTITY (same shape as SQLite, types tightened)
-- =========================================================================

CREATE TABLE IF NOT EXISTS employees (
  employee_id                   TEXT PRIMARY KEY,
  full_name                     TEXT NOT NULL,
  first_name                    TEXT,
  last_name                     TEXT,
  employee_email                TEXT,
  employee_status               TEXT,
  worker_type                   TEXT,
  employee_type                 TEXT,
  employee_title                TEXT,
  direct_manager_employee_id    TEXT,
  direct_manager_name           TEXT,
  cost_center_path              TEXT,
  cost_center_level_1           TEXT,
  cost_center_level_2           TEXT,
  cost_center_level_3           TEXT,
  department_or_function        TEXT,
  sub_department_or_team        TEXT,
  is_corporate                  BOOLEAN NOT NULL DEFAULT FALSE,
  location                      TEXT,
  market_id                     TEXT,
  employee_state                TEXT,
  tax_location                  TEXT,
  pay_group                     TEXT,
  pay_frequency                 TEXT,
  pay_calc                      TEXT,
  date_hired                    DATE,
  date_rehired                  DATE,
  date_terminated               DATE,
  position_effective_date       DATE,
  job_last_changed              DATE,
  tenure_days                   INTEGER,
  tenure_years                  REAL,
  synced_at                     TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_employees_email ON employees (LOWER(employee_email));
CREATE INDEX IF NOT EXISTS idx_employees_is_corporate ON employees (is_corporate);
CREATE INDEX IF NOT EXISTS idx_employees_department ON employees (department_or_function);

CREATE TABLE IF NOT EXISTS slack_users (
  slack_user_id    TEXT PRIMARY KEY,
  username         TEXT,
  display_name     TEXT,
  real_name        TEXT,
  email            TEXT,
  title            TEXT,
  timezone         TEXT,
  is_bot           BOOLEAN NOT NULL DEFAULT FALSE,
  is_restricted    BOOLEAN NOT NULL DEFAULT FALSE,
  is_deleted       BOOLEAN NOT NULL DEFAULT FALSE,
  observed_at      TIMESTAMPTZ NOT NULL,
  profile_fetched_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_slack_users_email ON slack_users (LOWER(email));

CREATE TABLE IF NOT EXISTS employee_slack_link (
  employee_id          TEXT PRIMARY KEY REFERENCES employees(employee_id) ON DELETE CASCADE,
  slack_user_id        TEXT REFERENCES slack_users(slack_user_id),
  match_method         TEXT NOT NULL,
  match_confidence     TEXT NOT NULL,
  match_notes          TEXT,
  manually_overridden  BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at          TIMESTAMPTZ NOT NULL
);

-- =========================================================================
-- SLACK CONTENT — with native JSONB and tsvector for hybrid retrieval
-- =========================================================================

CREATE TABLE IF NOT EXISTS channels (
  slack_channel_id    TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  channel_type        TEXT,
  is_archived         BOOLEAN NOT NULL DEFAULT FALSE,
  topic               TEXT,
  purpose             TEXT,
  creator_user_id     TEXT,
  created_ts          TIMESTAMPTZ,
  priority_tier       INTEGER,
  segment_code        TEXT,
  customer_slug       TEXT,
  project_status      TEXT,
  project_number      TEXT,
  ingestion_priority  TEXT NOT NULL DEFAULT 'normal',
  last_ingested_at    TIMESTAMPTZ,
  first_seen_at       TIMESTAMPTZ NOT NULL,
  last_seen_at        TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_name ON channels (name);
CREATE INDEX IF NOT EXISTS idx_channels_priority ON channels (ingestion_priority);

CREATE TABLE IF NOT EXISTS messages (
  slack_channel_id           TEXT NOT NULL REFERENCES channels(slack_channel_id) ON DELETE CASCADE,
  slack_ts                   TEXT NOT NULL,
  thread_ts                  TEXT,
  author_slack_user_id       TEXT,
  author_username            TEXT,
  text                       TEXT,
  message_type               TEXT,
  subtype                    TEXT,
  is_bot                     BOOLEAN NOT NULL DEFAULT FALSE,
  reactions                  JSONB,
  mentions_user_ids          JSONB,
  has_files                  BOOLEAN NOT NULL DEFAULT FALSE,
  has_links                  BOOLEAN NOT NULL DEFAULT FALSE,
  reply_count                INTEGER,
  edited_at_ts               TEXT,
  deleted                    BOOLEAN NOT NULL DEFAULT FALSE,
  raw_payload                JSONB NOT NULL,
  message_posted_at          TIMESTAMPTZ,
  ingested_at                TIMESTAMPTZ NOT NULL,
  -- Full-text search column (computed/indexed)
  text_tsv                   tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED,
  PRIMARY KEY (slack_channel_id, slack_ts)
);
CREATE INDEX IF NOT EXISTS idx_messages_channel_thread ON messages (slack_channel_id, thread_ts);
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages (author_slack_user_id);
CREATE INDEX IF NOT EXISTS idx_messages_posted_at ON messages (message_posted_at);
CREATE INDEX IF NOT EXISTS idx_messages_text_tsv ON messages USING GIN (text_tsv);

-- =========================================================================
-- THREADS — the embedded retrieval unit (per the research's recommendation)
-- =========================================================================

CREATE TABLE IF NOT EXISTS threads (
  thread_id              TEXT NOT NULL,           -- = slack_ts of the parent
  slack_channel_id       TEXT NOT NULL REFERENCES channels(slack_channel_id) ON DELETE CASCADE,
  parent_slack_ts        TEXT NOT NULL,
  message_count          INTEGER NOT NULL DEFAULT 1,
  participant_count      INTEGER NOT NULL DEFAULT 1,
  first_message_at       TIMESTAMPTZ,
  last_message_at        TIMESTAMPTZ,
  -- Anthropic Contextual Retrieval: a Haiku-generated 50-100 token prefix
  -- describing the thread's channel + topic + author context. Prepended
  -- before embedding to dramatically improve retrieval accuracy.
  context_prefix         TEXT,
  -- Concatenated thread text for embedding + FTS
  full_text              TEXT,
  full_text_tsv          tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(full_text, ''))) STORED,
  -- 512-dim halfvec (text-embedding-3-small Matryoshka-truncated, or voyage-3-lite)
  embedding              halfvec(512),
  embedding_model        TEXT,
  embedding_generated_at TIMESTAMPTZ,
  PRIMARY KEY (slack_channel_id, thread_id)
);
CREATE INDEX IF NOT EXISTS idx_threads_text_tsv ON threads USING GIN (full_text_tsv);
CREATE INDEX IF NOT EXISTS idx_threads_embedding_hnsw ON threads
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- =========================================================================
-- ENTITY EXTRACTIONS, EXEC FEEDBACK, ESCALATIONS — same shape as SQLite,
-- types tightened. (Full DDL omitted here for brevity — port from
-- db/schema.sql, swapping INTEGER PK + AUTOINCREMENT for BIGSERIAL,
-- TEXT timestamps for TIMESTAMPTZ, INTEGER booleans for BOOLEAN,
-- and JSON columns for JSONB.)
-- =========================================================================

-- ... (port the rest from db/schema.sql)
