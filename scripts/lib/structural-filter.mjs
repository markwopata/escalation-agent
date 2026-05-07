// Structural pre-filter for Tier A.
//
// Skips Slack messages that are clearly noise based on STRUCTURE — not
// content. (Content-based filters / keywords were rejected earlier as
// "old-world thinking" because they'd miss semantic signal. This filter
// is different: it acts on message envelope characteristics that have no
// semantic content to evaluate.)
//
// What this catches:
//   - "X has joined/left the channel" auto-posts
//   - Slack channel topic/purpose/name changes
//   - Bot integration confirmation messages (Front "connected", Slackbot
//     canvas updates, etc.)
//   - Empty message bodies
//   - Bare @mentions with no other content
//   - Pure emoji / reaction-only bodies
//
// What this does NOT catch (deliberately):
//   - Bot messages with real content (Datadog incident posts, PagerDuty
//     escalations, custom workflow bot output)
//   - Short messages with substance ("yes", "approved", "+1 to Mark") —
//     short ≠ noise
//   - Front integration messages that describe customer issues
//
// Usage:
//   const result = classifyAsStructuralNoise(message);
//   if (result) { /* skip Tier A; persist a free 'structural-filter'
//                    triage_run row with reason = result.reason */ }
//   else        { /* run Tier A normally */ }

const JOIN_LEAVE_RE = /^<@U\w+(?:\|[^>]*)?>\s+has\s+(joined|left)\s+the\s+channel\.?\s*$/i;
const SET_CHANNEL_META_RE = /^set\s+the\s+channel\s+(topic|purpose|description|name)/i;
const SLACKBOT_CANVAS_RE = /\bmade updates to a canvas tab\b/i;
const FRONT_INTEGRATION_CONNECT_RE = /\bconnected the .*\bFront\b.*\bintegration\b/i;
const RENAMED_CHANNEL_RE = /^has renamed the channel/i;
const BARE_MENTION_RE = /^(?:<@U\w+(?:\|[^>]*)?>\s*)+$/;
const EMOJI_ONLY_RE = /^(?:\s*:[a-zA-Z0-9_+-]+(?::[a-zA-Z0-9_-]+)?:\s*)+$/;

// Auto-response bots in help channels. Examples observed in the wild:
//   - "IT Support" bot in #help-it: "Hello, a ticket has been created for you in our IT portal..."
// These are confirmation-only messages with no decision content. Filter cheap.
const AUTO_TICKET_RESPONSE_RE = /^Hello,?\s+a\s+ticket\s+has\s+been\s+created/i;
const SUPPORT_TICKET_NUMBER_REPLY_RE = /^(your\s+)?(support\s+)?ticket\s+(#|number)/i;

// Slackbot deletion tombstones. The message body literally is "This message
// was deleted." — no signal possible.
const TOMBSTONE_TEXT_RE = /^This message was deleted\.?\s*$/i;

function stripMentions(text) {
  return (text ?? "").replace(/<@U\w+(?:\|[^>]*)?>/g, "").trim();
}

// Returns null if the message should go through full Tier A,
// or { reason: string } if it's structural noise.
export function classifyAsStructuralNoise(message) {
  const text = (message.text ?? "").trim();

  // 1. Empty body — including some bot integrations that post a file or
  // image without any text.
  if (text.length === 0 && !message.has_files) {
    return { reason: "empty body" };
  }

  // 2. Channel join/leave auto-posts.
  if (JOIN_LEAVE_RE.test(text)) {
    return { reason: "channel join/leave auto-post" };
  }

  // 3. Channel topic/purpose/description/name changes.
  if (SET_CHANNEL_META_RE.test(text) || RENAMED_CHANNEL_RE.test(text)) {
    return { reason: "channel metadata change" };
  }

  // 4. Slackbot canvas notifications — "Aaron Langston made updates to a
  // canvas tab: F0ACM3RFNHH"
  if (SLACKBOT_CANVAS_RE.test(text)) {
    return { reason: "slackbot canvas update" };
  }

  // 5. Front integration "X connected the Front Channel integration"
  // confirmation messages. Real customer-issue Front posts have different
  // structure.
  if (FRONT_INTEGRATION_CONNECT_RE.test(text)) {
    return { reason: "front integration setup confirmation" };
  }

  // 6. Bare @mention(s) with no body content.
  if (BARE_MENTION_RE.test(text)) {
    return { reason: "bare @mention, no content" };
  }

  // 7. Pure emoji / reaction-only bodies.
  if (EMOJI_ONLY_RE.test(text)) {
    return { reason: "emoji-only" };
  }

  // 8. After stripping mentions, the body is empty or near-empty AND the
  // message has no files. (Catches "<@user>   " or "<@user1> <@user2>".)
  const bodyAfterMentions = stripMentions(text);
  if (bodyAfterMentions.length === 0 && !message.has_files) {
    return { reason: "no content after stripping mentions" };
  }

  // 9. Bot subtype with extremely short body — typical of integration
  // status pings. Real bot signal (Datadog incident creation, PagerDuty
  // alert) has substantial text.
  if (message.is_bot && bodyAfterMentions.length < 40) {
    return { reason: "bot message with no substantive content" };
  }

  // 10. Slackbot tombstones — "This message was deleted." Has no signal
  // possible by definition. Slack subtypes this as 'tombstone'.
  if (message.subtype === "tombstone" || TOMBSTONE_TEXT_RE.test(text)) {
    return { reason: "deleted-message tombstone" };
  }

  // 11. Help-channel auto-response bots (e.g. "IT Support" in #help-it
  // posting "Hello, a ticket has been created..."). These are
  // confirmation-only messages with no decision content.
  if (AUTO_TICKET_RESPONSE_RE.test(text) || SUPPORT_TICKET_NUMBER_REPLY_RE.test(text)) {
    return { reason: "auto-response ticket-creation confirmation" };
  }

  return null;
}

// Dynamic silence rules from the silence_rules table. These are added by
// accepted Tier C proposals and take effect with no code changes.
//
// Supported rule_type values:
//   text_regex       — pattern is a JS regex (case-insensitive); matches against
//                      the message text. Optionally scoped to one channel.
//   channel_regex    — pattern matches the channel name; silences ALL messages
//                      in matching channels.
//   author_username  — pattern is a plain string; matches author_username exactly.
//
// Compiled once per script run. Pass the result to classifyAgainstDynamicRules.
export function loadCompiledSilenceRules(db) {
  const rows = db.prepare(`
    SELECT id, rule_type, pattern, scope_channel_id, reason
    FROM silence_rules
    WHERE active = 1
  `).all();
  const compiled = [];
  for (const r of rows) {
    try {
      const entry = { id: r.id, rule_type: r.rule_type, scope_channel_id: r.scope_channel_id, reason: r.reason };
      if (r.rule_type === "text_regex" || r.rule_type === "channel_regex") {
        entry.regex = new RegExp(r.pattern, "i");
      } else if (r.rule_type === "author_username") {
        entry.value = r.pattern;
      } else {
        // Unknown rule type — skip rather than throw.
        continue;
      }
      compiled.push(entry);
    } catch {
      // Bad regex — skip silently. Tier C should validate before insertion.
    }
  }
  return compiled;
}

export function classifyAgainstDynamicRules(rules, message) {
  if (!rules || rules.length === 0) return null;
  const text = (message.text ?? "").trim();
  const channelName = message.channel_name ?? "";
  const author = message.author_username ?? "";
  for (const r of rules) {
    if (r.scope_channel_id && r.scope_channel_id !== message.slack_channel_id) continue;
    if (r.rule_type === "text_regex" && text && r.regex.test(text)) {
      return { reason: r.reason || `silence rule #${r.id}` };
    }
    if (r.rule_type === "channel_regex" && channelName && r.regex.test(channelName)) {
      return { reason: r.reason || `silence rule #${r.id}` };
    }
    if (r.rule_type === "author_username" && author && r.value === author) {
      return { reason: r.reason || `silence rule #${r.id}` };
    }
  }
  return null;
}
