import { openDatabase, nowIso } from "./db.mjs";
import { extractEntities, persistEntities } from "./entity-extract.mjs";
import { loadWatchedExecs, detectInterventions, persistInterventions } from "./intervention-detector.mjs";
import { classifyAsNonHuman } from "./humans-only.mjs";

// Cache the watched-execs map per process. Cheap to refresh per message
// at startup; we re-read on each upsertMessage to pick up additions.
let _watchedCache = null;
let _watchedCacheTime = 0;
function getWatchedExecs(db) {
  const ttlMs = 30000;
  if (!_watchedCache || (Date.now() - _watchedCacheTime) > ttlMs) {
    _watchedCache = loadWatchedExecs(db);
    _watchedCacheTime = Date.now();
  }
  return _watchedCache;
}

// Parses an EquipmentShare per-project channel name like
//   1dc-vantagewisconsin-m-020 / 2ind-dardensolar-m-014 / 1dc-oesabilene-m002
// Returns { priority_tier, segment_code, customer_slug, project_status, project_number }
// or all-null if the channel doesn't match the pattern.
const PROJECT_NAME_RE = /^(\d)(dc|ind|co|cm)-([a-z0-9]+)-([a-z])-?(\d{2,3})$/;

export function parseProjectChannelName(name) {
  if (!name) {
    return { priority_tier: null, segment_code: null, customer_slug: null, project_status: null, project_number: null };
  }
  const match = PROJECT_NAME_RE.exec(name);
  if (!match) {
    return { priority_tier: null, segment_code: null, customer_slug: null, project_status: null, project_number: null };
  }
  return {
    priority_tier: Number(match[1]),
    segment_code: match[2],
    customer_slug: match[3],
    project_status: match[4],
    project_number: match[5],
  };
}

// Convert a Slack ts (e.g. "1776452659.869839") to ISO-8601 UTC.
export function slackTsToIso(ts) {
  if (!ts) return null;
  const seconds = Number(String(ts).split(".")[0]);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

// Extract user IDs mentioned in Slack message text (`<@U049CJZG5>` and `<@U049CJZG5|name>`).
export function extractMentions(text) {
  if (!text) return [];
  const ids = new Set();
  const regex = /<@(U[A-Z0-9]+)(?:\|[^>]*)?>/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    ids.add(match[1]);
  }
  return Array.from(ids);
}

const UPSERT_CHANNEL_SQL = `
INSERT INTO channels (
  slack_channel_id, name, channel_type, is_archived, topic, purpose,
  creator_user_id, created_ts,
  priority_tier, segment_code, customer_slug, project_status, project_number,
  ingestion_priority, first_seen_at, last_seen_at
) VALUES (
  @slack_channel_id, @name, @channel_type, @is_archived, @topic, @purpose,
  @creator_user_id, @created_ts,
  @priority_tier, @segment_code, @customer_slug, @project_status, @project_number,
  @ingestion_priority, @first_seen_at, @last_seen_at
)
ON CONFLICT(slack_channel_id) DO UPDATE SET
  name = excluded.name,
  channel_type = excluded.channel_type,
  is_archived = excluded.is_archived,
  topic = COALESCE(excluded.topic, channels.topic),
  purpose = COALESCE(excluded.purpose, channels.purpose),
  creator_user_id = COALESCE(excluded.creator_user_id, channels.creator_user_id),
  created_ts = COALESCE(excluded.created_ts, channels.created_ts),
  priority_tier = excluded.priority_tier,
  segment_code = excluded.segment_code,
  customer_slug = excluded.customer_slug,
  project_status = excluded.project_status,
  project_number = excluded.project_number,
  last_seen_at = excluded.last_seen_at
`;

export function upsertChannel(db, channel) {
  const parsed = parseProjectChannelName(channel.name);
  const now = nowIso();
  db.prepare(UPSERT_CHANNEL_SQL).run({
    slack_channel_id: channel.id ?? channel.slack_channel_id,
    name: channel.name,
    channel_type: channel.channel_type ?? channel.type ?? null,
    is_archived: channel.is_archived ? 1 : 0,
    topic: channel.topic ?? null,
    purpose: channel.purpose ?? null,
    creator_user_id: channel.creator_user_id ?? channel.creator ?? null,
    created_ts: channel.created_ts ?? null,
    priority_tier: parsed.priority_tier,
    segment_code: parsed.segment_code,
    customer_slug: parsed.customer_slug,
    project_status: parsed.project_status,
    project_number: parsed.project_number,
    ingestion_priority: channel.ingestion_priority ?? "normal",
    first_seen_at: now,
    last_seen_at: now,
  });
}

const UPSERT_SLACK_USER_SQL = `
INSERT INTO slack_users (
  slack_user_id, username, display_name, real_name, email, title, timezone,
  is_bot, is_restricted, is_deleted, observed_at, profile_fetched_at
) VALUES (
  @slack_user_id, @username, @display_name, @real_name, @email, @title, @timezone,
  @is_bot, @is_restricted, @is_deleted, @observed_at, @profile_fetched_at
)
ON CONFLICT(slack_user_id) DO UPDATE SET
  username = COALESCE(excluded.username, slack_users.username),
  display_name = COALESCE(excluded.display_name, slack_users.display_name),
  real_name = COALESCE(excluded.real_name, slack_users.real_name),
  email = COALESCE(excluded.email, slack_users.email),
  title = COALESCE(excluded.title, slack_users.title),
  timezone = COALESCE(excluded.timezone, slack_users.timezone),
  is_bot = MAX(slack_users.is_bot, excluded.is_bot),
  is_restricted = excluded.is_restricted,
  is_deleted = excluded.is_deleted,
  profile_fetched_at = COALESCE(excluded.profile_fetched_at, slack_users.profile_fetched_at)
`;

export function upsertSlackUser(db, user) {
  if (!user || !(user.slack_user_id || user.id)) return;
  const now = nowIso();
  db.prepare(UPSERT_SLACK_USER_SQL).run({
    slack_user_id: user.slack_user_id ?? user.id,
    username: user.username ?? null,
    display_name: user.display_name ?? null,
    real_name: user.real_name ?? user.name ?? null,
    email: user.email ?? null,
    title: user.title ?? null,
    timezone: user.timezone ?? user.tz ?? null,
    is_bot: user.is_bot ? 1 : 0,
    is_restricted: user.is_restricted ? 1 : 0,
    is_deleted: user.is_deleted ? 1 : 0,
    observed_at: now,
    profile_fetched_at: user.profile_fetched_at ?? null,
  });
}

const UPSERT_MESSAGE_SQL = `
INSERT INTO messages (
  slack_channel_id, slack_ts, thread_ts, author_slack_user_id, author_username,
  text, message_type, subtype, is_bot, reactions_json, mentions_user_ids_json,
  has_files, has_links, reply_count, edited_at_ts, deleted, raw_payload,
  message_posted_at, ingested_at
) VALUES (
  @slack_channel_id, @slack_ts, @thread_ts, @author_slack_user_id, @author_username,
  @text, @message_type, @subtype, @is_bot, @reactions_json, @mentions_user_ids_json,
  @has_files, @has_links, @reply_count, @edited_at_ts, @deleted, @raw_payload,
  @message_posted_at, @ingested_at
)
ON CONFLICT(slack_channel_id, slack_ts) DO UPDATE SET
  thread_ts = excluded.thread_ts,
  author_slack_user_id = COALESCE(excluded.author_slack_user_id, messages.author_slack_user_id),
  author_username = COALESCE(excluded.author_username, messages.author_username),
  text = excluded.text,
  message_type = excluded.message_type,
  subtype = excluded.subtype,
  is_bot = excluded.is_bot,
  reactions_json = excluded.reactions_json,
  mentions_user_ids_json = excluded.mentions_user_ids_json,
  has_files = excluded.has_files,
  has_links = excluded.has_links,
  reply_count = COALESCE(excluded.reply_count, messages.reply_count),
  edited_at_ts = excluded.edited_at_ts,
  deleted = excluded.deleted,
  raw_payload = excluded.raw_payload,
  message_posted_at = excluded.message_posted_at
`;

export function upsertMessage(db, channelId, message) {
  // HUMANS-ONLY GATE — exec-level rule. Bots, AI chatbots posing as users
  // (Arnold etc.), Slackbot system messages, deletion tombstones, and
  // channel-event auto-posts never enter the DB. They cost nothing
  // downstream because they don't exist downstream.
  //
  // Note: channel_join events for watched execs ARE useful signal but the
  // FK on ceo_interventions requires a message row. For now we accept this
  // limitation; if exec wants channel-join tracking, drop the FK on
  // ceo_interventions and persist a sentinel intervention here.
  const nonHuman = classifyAsNonHuman(message, db);
  if (nonHuman) {
    return { skipped: true, reason: nonHuman.reason };
  }

  const reactions = message.reactions ?? null;
  const text = message.text ?? "";
  const mentions = extractMentions(text);
  const hasLinks = /<https?:\/\/[^>|]+/.test(text);
  const hasFiles = Array.isArray(message.files) && message.files.length > 0;

  // Capture the author's username for later resolution if we don't have a profile yet.
  if (message.user || message.user_id || message.author_slack_user_id) {
    upsertSlackUser(db, {
      slack_user_id: message.user ?? message.user_id ?? message.author_slack_user_id,
      username: message.username ?? null,
      real_name: message.user_profile?.real_name ?? null,
      display_name: message.user_profile?.display_name ?? null,
      is_bot: Boolean(message.bot_id) || message.subtype === "bot_message",
    });
  }

  db.prepare(UPSERT_MESSAGE_SQL).run({
    slack_channel_id: channelId,
    slack_ts: String(message.ts ?? message.slack_ts),
    thread_ts: message.thread_ts ? String(message.thread_ts) : null,
    author_slack_user_id: message.user ?? message.user_id ?? message.author_slack_user_id ?? null,
    author_username: message.username ?? message.user_profile?.display_name ?? message.user_profile?.real_name ?? null,
    text,
    message_type: message.type ?? "message",
    subtype: message.subtype ?? null,
    is_bot: (message.bot_id || message.subtype === "bot_message") ? 1 : 0,
    reactions_json: reactions ? JSON.stringify(reactions) : null,
    mentions_user_ids_json: mentions.length ? JSON.stringify(mentions) : null,
    has_files: hasFiles ? 1 : 0,
    has_links: hasLinks ? 1 : 0,
    reply_count: message.reply_count ?? null,
    edited_at_ts: message.edited?.ts ?? null,
    deleted: 0,
    raw_payload: JSON.stringify(message),
    message_posted_at: slackTsToIso(message.ts ?? message.slack_ts),
    ingested_at: nowIso(),
  });

  // Entity extraction at ingest. Free, idempotent (replaces prior rows for
  // this message). Bridges un-threaded re-emergence: "all messages mentioning
  // Vantage" or "all messages with WO-7388474" become exact-match SQL queries.
  const entities = extractEntities(text);
  if (entities.length) {
    persistEntities(db, channelId, String(message.ts ?? message.slack_ts), entities);
  }

  // Watched-exec intervention detection. Authored / mentioned / etc. by
  // CEO or other top-tier execs is gold-standard ground truth — feeds Tier C.
  const watched = getWatchedExecs(db);
  if (watched.size > 0) {
    const ts = String(message.ts ?? message.slack_ts);
    const detectMessage = {
      slack_channel_id: channelId,
      slack_ts: ts,
      thread_ts: message.thread_ts ? String(message.thread_ts) : null,
      author_slack_user_id: message.user ?? message.user_id ?? message.author_slack_user_id ?? null,
      text,
      mentions_user_ids_json: mentions.length ? JSON.stringify(mentions) : null,
      message_posted_at: slackTsToIso(message.ts ?? message.slack_ts),
    };
    const interventions = detectInterventions(detectMessage, watched);
    if (interventions.length) persistInterventions(db, interventions);
  }
}

// Try to resolve every unlinked Slack user to an employees row by email match.
// Idempotent: never overwrites a manually_overridden=1 link.
export function reconcileEmployeeLinks(db) {
  const now = nowIso();
  const candidates = db.prepare(`
    SELECT su.slack_user_id, su.email
    FROM slack_users su
    LEFT JOIN employee_slack_link link ON link.slack_user_id = su.slack_user_id
    WHERE su.email IS NOT NULL
      AND su.email != ''
      AND su.is_bot = 0
      AND link.slack_user_id IS NULL
  `).all();

  let resolved = 0;
  const upsertLink = db.prepare(`
    INSERT INTO employee_slack_link (
      employee_id, slack_user_id, match_method, match_confidence, match_notes, manually_overridden, resolved_at
    ) VALUES (
      @employee_id, @slack_user_id, 'email_exact', 'high', NULL, 0, @resolved_at
    )
    ON CONFLICT(employee_id) DO UPDATE SET
      slack_user_id = excluded.slack_user_id,
      match_method = excluded.match_method,
      match_confidence = excluded.match_confidence,
      resolved_at = excluded.resolved_at
    WHERE employee_slack_link.manually_overridden = 0
  `);
  const findEmployee = db.prepare(`SELECT employee_id FROM employees WHERE LOWER(employee_email) = LOWER(?)`);

  const txn = db.transaction(() => {
    for (const cand of candidates) {
      const employee = findEmployee.get(cand.email);
      if (!employee) continue;
      upsertLink.run({
        employee_id: employee.employee_id,
        slack_user_id: cand.slack_user_id,
        resolved_at: now,
      });
      resolved += 1;
    }
  });
  txn();

  return { resolved, candidates_examined: candidates.length };
}

export { openDatabase };
