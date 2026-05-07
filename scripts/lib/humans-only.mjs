// "Humans only" gate at ingest time.
//
// EquipmentShare's escalation agent is exclusively interested in messages
// authored by humans. Bots, AI chatbots posing as users (Arnold etc.),
// Slackbot system messages, deletion tombstones, and channel-event auto-
// posts (joins/leaves/topic-changes) are all out of scope and never reach
// the DB.
//
// Three sources of "non-human":
//   1. Slack envelope flags: message.is_bot, message.bot_id, or
//      subtype === 'bot_message'
//   2. System / event subtypes: 'tombstone', 'channel_join', 'channel_leave',
//      'channel_topic', 'channel_purpose', 'channel_name', 'channel_archive',
//      'channel_unarchive', 'pinned_item', 'unpinned_item', etc.
//   3. The non_human_authors table — for AI chatbots that post as a regular
//      user account (Arnold, workflow bots, etc.). Slackbot (USLACKBOT) is
//      always seeded.
//
// Returns null if the message IS a human message, or { reason } otherwise.

const SYSTEM_SUBTYPES = new Set([
  "tombstone",
  "channel_join", "channel_leave",
  "channel_topic", "channel_purpose", "channel_name",
  "channel_archive", "channel_unarchive",
  "pinned_item", "unpinned_item",
  "bot_message",
  "bot_add", "bot_remove",
  "reminder_add", "reminder_delete",
  "file_share", // sometimes auto-generated; keep an eye on this one
]);

// Always-skip Slack user IDs that are not real humans.
const ALWAYS_NON_HUMAN = new Set([
  "USLACKBOT",   // Slackbot
]);

// Cache the non_human_authors set briefly so we don't hammer the DB.
let _cache = null;
let _cacheAt = 0;
function getNonHumanAuthors(db) {
  if (!_cache || (Date.now() - _cacheAt) > 30000) {
    _cache = new Set(ALWAYS_NON_HUMAN);
    if (db) {
      const rows = db.prepare("SELECT slack_user_id FROM non_human_authors").all();
      for (const r of rows) _cache.add(r.slack_user_id);
    }
    _cacheAt = Date.now();
  }
  return _cache;
}

export function classifyAsNonHuman(message, db) {
  // Slack-envelope bot indicators
  if (message.bot_id) return { reason: "Slack bot_id present" };
  if (message.is_bot === true || message.is_bot === 1) return { reason: "Slack is_bot=true" };
  const subtype = message.subtype ?? null;
  if (subtype === "bot_message") return { reason: "subtype=bot_message" };

  // System/event subtypes (never message-shaped content)
  if (subtype && SYSTEM_SUBTYPES.has(subtype)) {
    return { reason: `system subtype=${subtype}` };
  }

  // Author-based exclusion list (covers Slackbot + AI chatbots like Arnold)
  const author = message.user ?? message.user_id ?? message.author_slack_user_id ?? null;
  if (author) {
    const set = getNonHumanAuthors(db);
    if (set.has(author)) return { reason: `excluded author (${author})` };
  }

  return null;
}

export function isHumanMessage(message, db) {
  return classifyAsNonHuman(message, db) === null;
}

// Resets the cache after additions to non_human_authors so subsequent calls
// pick up the change.
export function refreshNonHumanCache() {
  _cache = null;
  _cacheAt = 0;
}
