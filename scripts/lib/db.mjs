import { resolve } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { repoRoot } from "./load-env.mjs";

const DEFAULT_DB_PATH = resolve(repoRoot, "data", "escalation.db");
const SCHEMA_PATH = resolve(repoRoot, "db", "schema.sql");

let cachedDb = null;

export function openDatabase(dbPath = DEFAULT_DB_PATH) {
  if (cachedDb && cachedDb.name === dbPath) {
    return cachedDb.connection;
  }

  mkdirSync(resolve(dbPath, ".."), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  applySchema(db);

  cachedDb = { name: dbPath, connection: db };
  return db;
}

function applySchema(db) {
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  applyMigrations(db);
}

// Idempotent column-additions for tables that pre-existed before a schema
// change. SQLite has no IF NOT EXISTS for ADD COLUMN, so we check
// pragma_table_info first.
function applyMigrations(db) {
  const ensureColumn = (table, name, sql) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some(c => c.name === name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${sql}`);
    }
  };
  // escalations.display_title / .display_title_short_summary
  ensureColumn("escalations", "display_title", "display_title TEXT");
  ensureColumn("escalations", "display_title_short_summary", "display_title_short_summary TEXT");
  // exec_feedback exemplars: a feedback row can point at a specific source
  // Slack message (the "this is what I want flagged" exemplar) rather than
  // an escalation. target_slack_channel_id + target_slack_ts identify it.
  ensureColumn("exec_feedback", "target_slack_channel_id", "target_slack_channel_id TEXT");
  ensureColumn("exec_feedback", "target_slack_ts", "target_slack_ts TEXT");
  // Front sources: an escalation can come from Slack (default) or Front.
  // For Front escalations, slack_channel_id is null and we use the
  // Front-specific identifiers below.
  ensureColumn("escalations", "source", "source TEXT NOT NULL DEFAULT 'slack'");
  ensureColumn("escalations", "front_conversation_id", "front_conversation_id TEXT");
  ensureColumn("escalations", "front_inbox_id", "front_inbox_id TEXT");
  ensureColumn("escalations", "front_investigation_id", "front_investigation_id INTEGER");
  // Display emoji: contextual single-character emoji that signals what kind
  // of issue this is (not severity — every escalation is a problem already).
  // Backfilled by scripts/backfill-escalation-emojis.mjs via Haiku.
  ensureColumn("escalations", "display_emoji", "display_emoji TEXT");

  // signal_event_at: timestamp of the most recent material customer event
  // associated with this escalation. Used by the digest dedupe to decide
  // whether to re-deliver an already-delivered escalation. For Front, that's
  // MAX(front_messages.created_at WHERE role='customer') across cluster
  // members. For Slack, MAX(messages.message_posted_at) across cluster.
  // Written by both rollup scripts. NULL until first rollup post-migration —
  // a backfill script populates existing rows.
  ensureColumn("escalations", "signal_event_at", "signal_event_at TEXT");

  // Drop the unique index on (recipient_slack_user_id, escalation_id) so the
  // digest can record multiple delivery rows when an escalation is re-
  // delivered after a new customer follow-up. Audit history > insert-or-ignore.
  db.exec(`DROP INDEX IF EXISTS idx_digest_deliveries_unique`);

  // digest_revalidations: audit trail of pre-delivery thread re-checks.
  // Populated by scripts/lib/digest-revalidate.mjs. Lets us see false-positive
  // rates over time and feed Tier C reflection.
  db.exec(`
    CREATE TABLE IF NOT EXISTS digest_revalidations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      escalation_id INTEGER NOT NULL REFERENCES escalations(id),
      checked_at TEXT NOT NULL,
      reply_count INTEGER,
      latest_reply_ts TEXT,
      latest_reply_author TEXT,
      should_drop INTEGER NOT NULL DEFAULT 0,
      drop_reason TEXT,
      status_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_digest_revalidations_esc ON digest_revalidations(escalation_id);
    CREATE INDEX IF NOT EXISTS idx_digest_revalidations_dropped ON digest_revalidations(should_drop, checked_at);
  `);
}

export function nowIso() {
  return new Date().toISOString();
}

// Normalize a timestamp string to ISO format ("YYYY-MM-DDTHH:MM:SS.sssZ").
// Snowflake returns timestamps as "2026-05-01 11:30:48.594000+00:00"
// (space separator, +00:00 zone), while everywhere else we use ISO. SQLite
// string comparisons across these formats are wrong because ' ' (0x20) <
// 'T' (0x54), so Snowflake-format dates always compare LESS than ISO dates
// regardless of actual time. This silently breaks recency filters.
//
// Call this on any timestamp string before storing it. Idempotent — already-
// ISO strings round-trip unchanged. Null/undefined return null.
export function toIsoTs(s) {
  if (s == null) return null;
  if (typeof s !== "string") {
    // Date instance, number, etc. — pass through Date constructor.
    try { return new Date(s).toISOString(); } catch { return null; }
  }
  // Already ISO?
  if (s.length >= 11 && s[10] === "T" && (s.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(s))) {
    // Convert any +00:00 → Z for consistency.
    return s.replace(/\+00:?00$/, "Z");
  }
  // Snowflake-style "YYYY-MM-DD HH:MM:SS[.sss][+HH:MM]"
  const m = s.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:([+-]\d{2}):?(\d{2}))?$/);
  if (m) {
    const date = m[1];
    const time = m[2];
    const tz = m[3] && m[4] ? `${m[3]}:${m[4]}` : "+00:00";
    return tz === "+00:00" ? `${date}T${time}Z` : `${date}T${time}${tz}`;
  }
  // Fallback — try Date parse.
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return s;
}
