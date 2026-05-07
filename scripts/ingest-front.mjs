// Front backfill: pull all inboxes + last-N-hours of conversations + threads
// from Snowflake (PEOPLE_ANALYTICS.FRONT_ESCALATION) and persist locally.
//
// Usage:
//   node scripts/ingest-front.mjs --hours 24             # default
//   node scripts/ingest-front.mjs --hours 24 --dry-run   # count only, no writes
//   node scripts/ingest-front.mjs --inbox-limit 50       # cap to top N inboxes by volume (testing)
//
// Strategy:
//   1. Snapshot all inboxes (front_inboxes upsert).
//   2. Pull CONVERSATION_SUMMARY for last N hours; persist to front_conversations.
//   3. For each conversation, pull THREAD_FLAT turns (deduped on MESSAGE_ID,
//      role-corrected via applyRoleFix), persist to front_messages.
//
// We deliberately do NOT pull every historical conversation — only the
// window. Older context is hydrated from Snowflake on demand by Tier B/C.

import process from "node:process";
import { openDatabase, nowIso, toIsoTs } from "./lib/db.mjs";
import { executeSqlThroughFrostyWithWarehouse } from "./lib/frosty-client.mjs";
import { applyRoleFix } from "./lib/front-role-fix.mjs";

function parseArgs(argv) {
  // Default 48h — Snowflake refresh lags ~24h behind clock time; 48h
  // captures a full day of actual data.
  const args = { hours: 48, dryRun: false, inboxLimit: null, threadConcurrency: 8 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--hours") args.hours = Number(argv[++i]);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--inbox-limit") args.inboxLimit = Number(argv[++i]);
    else if (a === "--thread-concurrency") args.threadConcurrency = Number(argv[++i]);
  }
  return args;
}

function classifyInbox(name) {
  if (!name) return "unknown";
  const n = name.toLowerCase();
  if (/ - sales$/i.test(name)) return "branch-sales";
  if (/ - service$/i.test(name)) return "branch-service";
  if (/ - parts$/i.test(name)) return "branch-parts";
  if (/(es track support|trackunit)/i.test(name)) return "workflow-bot";
  if (/(legal|insurance|tax|government rentals|certificates of insurance)/i.test(name)) return "legal";
  if (/(customer support|t3 support|billing & payments|fleet$|customer support \(text)/i.test(name)) return "customer-facing";
  if (/(ap |fleet invoicing|fleet payables|ach remits|stripe|intacct|vendors|coi scans|waiver|branch orders|logistics|credit$)/i.test(name)) return "back-office";
  return "unknown";
}

async function snapshotInboxes(db, args) {
  console.log("[1/3] Snapshotting all inboxes...");
  const sql = `WITH s AS (SELECT INBOX_ID, ANY_VALUE(INBOX_NAME) AS name, COUNT(*) AS conv_count FROM PEOPLE_ANALYTICS.FRONT_ESCALATION.FRONT_ESCALATION_CONVERSATION_SUMMARY WHERE CONVERSATION_CREATED_AT >= DATEADD(hour, -${args.hours * 4}, CURRENT_TIMESTAMP()) GROUP BY INBOX_ID) SELECT * FROM s`;
  const r = await executeSqlThroughFrostyWithWarehouse(sql.trim());
  if (!r.success) throw new Error(`Inbox snapshot failed: ${r.error}`);
  console.log(`  Found ${r.data.length} inboxes with traffic in last ${args.hours * 4}h.`);
  if (args.dryRun) return r.data;

  const upsert = db.prepare(`
    INSERT INTO front_inboxes (inbox_id, name, inbox_kind, triage_enabled, ingested_at)
    VALUES (@inbox_id, @name, @kind, @triage, @at)
    ON CONFLICT (inbox_id) DO UPDATE SET name = excluded.name, ingested_at = excluded.ingested_at
  `);
  const now = nowIso();
  let inserted = 0;
  const txn = db.transaction((rows) => {
    for (const row of rows) {
      const kind = classifyInbox(row.NAME);
      const triage = kind === "workflow-bot" ? 0 : 1;
      upsert.run({ inbox_id: row.INBOX_ID, name: row.NAME, kind, triage, at: now });
      inserted += 1;
    }
  });
  txn(r.data);
  console.log(`  Persisted ${inserted} inboxes.`);
  return r.data;
}

async function pullConversations(db, args) {
  // Frosty/Snowflake response capped at 10K rows per query. Busy days
  // (~28K conversations) get clipped → silent data loss. Fix by chunking
  // the time window into 1-hour slices; each slice has ≤2K conversations.
  console.log(`[2/3] Pulling conversations from last ${args.hours}h (paginated by hour to avoid 10K row cap)...`);
  const inboxFilter = args.inboxLimit
    ? `AND INBOX_ID IN (SELECT INBOX_ID FROM (SELECT INBOX_ID, COUNT(*) AS n FROM PEOPLE_ANALYTICS.FRONT_ESCALATION.FRONT_ESCALATION_CONVERSATION_SUMMARY WHERE CONVERSATION_CREATED_AT >= DATEADD(hour, -${args.hours}, CURRENT_TIMESTAMP()) GROUP BY INBOX_ID ORDER BY n DESC LIMIT ${args.inboxLimit}))`
    : "";

  const allRows = [];
  for (let h = args.hours; h > 0; h -= 1) {
    // Per-hour slice: [-h hours, -(h-1) hours)
    const sql = `WITH s AS (
      SELECT CONVERSATION_ID, INBOX_ID, INBOX_NAME, CONVERSATION_SUBJECT,
             CONVERSATION_CREATED_AT, CURRENT_STATUS, CURRENT_TEAMMATE_ID,
             RECIPIENT_HANDLE, RECIPIENT_ROLE,
             FIRST_INBOUND_AT, FIRST_OUTBOUND_AT,
             MINUTES_TO_FIRST_REPLY, LAST_MESSAGE_AT,
             TOTAL_MESSAGE_COUNT, INBOUND_MESSAGE_COUNT, OUTBOUND_MESSAGE_COUNT
      FROM PEOPLE_ANALYTICS.FRONT_ESCALATION.FRONT_ESCALATION_CONVERSATION_SUMMARY
      WHERE CONVERSATION_CREATED_AT >= DATEADD(hour, -${h}, CURRENT_TIMESTAMP())
        AND CONVERSATION_CREATED_AT <  DATEADD(hour, -${h - 1}, CURRENT_TIMESTAMP())
        ${inboxFilter}
    ) SELECT * FROM s`;
    const r = await executeSqlThroughFrostyWithWarehouse(sql.trim());
    if (!r.success) {
      console.error(`  hour -${h}h slice failed: ${r.error}`);
      continue;
    }
    if (r.data.length >= 10000) {
      console.warn(`  ⚠ hour -${h}h returned ${r.data.length} rows — may have hit cap. Consider sub-hour slicing.`);
    }
    allRows.push(...r.data);
    if ((args.hours - h) % 24 === 0 && allRows.length > 0) {
      console.log(`  ...${args.hours - h}h done · ${allRows.length} conversations so far`);
    }
  }
  console.log(`  Got ${allRows.length} conversations across ${args.hours} hourly slices.`);
  if (args.dryRun) return allRows;

  const upsert = db.prepare(`
    INSERT INTO front_conversations (
      conversation_id, inbox_id, inbox_name, subject, current_status, current_teammate_id,
      recipient_handle, recipient_role, conversation_created_at, first_inbound_at, first_outbound_at,
      minutes_to_first_reply, last_message_at,
      total_message_count, inbound_message_count, outbound_message_count, ingested_at
    ) VALUES (
      @cid, @inbox_id, @inbox_name, @subject, @status, @teammate,
      @recip_handle, @recip_role, @created, @first_in, @first_out,
      @mtr, @last_msg, @total, @inbound, @outbound, @at
    )
    ON CONFLICT (conversation_id) DO UPDATE SET
      current_status = excluded.current_status,
      current_teammate_id = excluded.current_teammate_id,
      first_outbound_at = excluded.first_outbound_at,
      minutes_to_first_reply = excluded.minutes_to_first_reply,
      last_message_at = excluded.last_message_at,
      total_message_count = excluded.total_message_count,
      inbound_message_count = excluded.inbound_message_count,
      outbound_message_count = excluded.outbound_message_count,
      ingested_at = excluded.ingested_at
  `);
  const now = nowIso();
  let n = 0;
  const txn = db.transaction((rows) => {
    for (const row of rows) {
      // Normalize Snowflake-format timestamps to ISO so SQL string comparisons
      // are correct across Slack (already ISO) and Front (Snowflake space-format).
      // See lib/db.mjs toIsoTs comment for the silent-bug history.
      upsert.run({
        cid: row.CONVERSATION_ID, inbox_id: row.INBOX_ID, inbox_name: row.INBOX_NAME,
        subject: row.CONVERSATION_SUBJECT, status: row.CURRENT_STATUS,
        teammate: row.CURRENT_TEAMMATE_ID, recip_handle: row.RECIPIENT_HANDLE,
        recip_role: row.RECIPIENT_ROLE, created: toIsoTs(row.CONVERSATION_CREATED_AT),
        first_in: toIsoTs(row.FIRST_INBOUND_AT), first_out: toIsoTs(row.FIRST_OUTBOUND_AT),
        mtr: row.MINUTES_TO_FIRST_REPLY,
        last_msg: toIsoTs(row.LAST_MESSAGE_AT), total: row.TOTAL_MESSAGE_COUNT,
        inbound: row.INBOUND_MESSAGE_COUNT, outbound: row.OUTBOUND_MESSAGE_COUNT,
        at: now,
      });
      n += 1;
    }
  });
  txn(allRows);
  console.log(`  Persisted ${n} conversations.`);
  return allRows;
}

async function pullThreadsBatch(db, conversationIds, batchSize = 50) {
  // Pull threads for a batch of conversation IDs in a single SQL roundtrip.
  // Front conversations average ~4 turns each, so 50 conversations ≈ 200 rows.
  if (conversationIds.length === 0) return 0;
  const idList = conversationIds.map(id => `'${id.replace(/'/g, "''")}'`).join(",");
  const sql = `WITH t AS (
    SELECT CONVERSATION_ID, MESSAGE_ID,
           MIN(TURN_INDEX) AS turn_index,
           ANY_VALUE(ROLE) AS role,
           ANY_VALUE(AUTHOR_ID) AS author_id,
           ANY_VALUE(CREATED_AT) AS created_at,
           ANY_VALUE(TEXT) AS text
    FROM PEOPLE_ANALYTICS.FRONT_ESCALATION.FRONT_ESCALATION_THREAD_FLAT
    WHERE CONVERSATION_ID IN (${idList})
    GROUP BY CONVERSATION_ID, MESSAGE_ID
  ) SELECT * FROM t`;
  const r = await executeSqlThroughFrostyWithWarehouse(sql.trim());
  if (!r.success) throw new Error(`Thread batch pull failed: ${r.error}`);

  const upsert = db.prepare(`
    INSERT INTO front_messages (message_id, conversation_id, turn_index, role, raw_role, author_id, created_at, text, ingested_at)
    VALUES (@mid, @cid, @turn, @role, @raw_role, @author, @created, @text, @at)
    ON CONFLICT (message_id) DO UPDATE SET
      role = excluded.role, raw_role = excluded.raw_role,
      text = excluded.text, ingested_at = excluded.ingested_at
  `);
  const now = nowIso();
  // Apply role fix per row before persisting.
  const corrected = applyRoleFix(r.data.map(d => ({ ROLE: d.ROLE, TEXT: d.TEXT, AUTHOR_ID: d.AUTHOR_ID })));
  const txn = db.transaction(() => {
    for (let i = 0; i < r.data.length; i += 1) {
      const d = r.data[i];
      const fixedRole = corrected[i].ROLE;
      upsert.run({
        mid: d.MESSAGE_ID, cid: d.CONVERSATION_ID, turn: d.TURN_INDEX,
        role: fixedRole, raw_role: d.ROLE,
        author: d.AUTHOR_ID, created: toIsoTs(d.CREATED_AT), text: d.TEXT, at: now,
      });
    }
  });
  txn();
  return r.data.length;
}

async function pullThreads(db, conversations, args) {
  console.log(`[3/3] Pulling thread bodies for ${conversations.length} conversations...`);
  if (args.dryRun) return;
  const ids = conversations.map(c => c.CONVERSATION_ID);
  const BATCH = 50;
  let totalRows = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    try {
      const rows = await pullThreadsBatch(db, batch);
      totalRows += rows;
    } catch (err) {
      console.error(`  batch ${i}/${ids.length} failed: ${err.message}`);
    }
    if ((i / BATCH) % 10 === 0) {
      console.log(`  ${i + batch.length}/${ids.length} conversations · ${totalRows} turns persisted`);
    }
  }
  console.log(`  Done: ${totalRows} total turns persisted.`);
}

async function main() {
  const args = parseArgs(process.argv);
  const db = openDatabase();
  console.log(`Front backfill: last ${args.hours}h${args.dryRun ? " (DRY RUN)" : ""}${args.inboxLimit ? ` (top ${args.inboxLimit} inboxes)` : ""}`);
  console.log("---");
  const start = Date.now();
  try {
    await snapshotInboxes(db, args);
    const conversations = await pullConversations(db, args);
    await pullThreads(db, conversations, args);
    const dur = Math.round((Date.now() - start) / 1000);
    console.log(`---\nFront backfill complete in ${dur}s.`);
    if (!args.dryRun) {
      const counts = db.prepare("SELECT (SELECT COUNT(*) FROM front_inboxes) AS inboxes, (SELECT COUNT(*) FROM front_conversations) AS conversations, (SELECT COUNT(*) FROM front_messages) AS messages").get();
      console.log(`Local DB now holds: ${counts.inboxes} inboxes · ${counts.conversations} conversations · ${counts.messages} messages.`);
    }
  } catch (err) {
    console.error("Backfill failed:", err.message);
    process.exit(1);
  }
}

await main();
