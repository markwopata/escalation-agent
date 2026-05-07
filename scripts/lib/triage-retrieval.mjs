// Cross-message retrieval bundle for Tier A triage.
//
// Per-message triage is blind to patterns that emerge across messages.
// Real example from our own data: Liz Hughson posted 3 similar customer-relay
// messages over 6 days. Each looked routine in isolation; only the cluster
// matters. This module assembles cheap, deterministic context (SQL only — no
// embeddings yet) that gets injected into Haiku's user message so it can see:
//
//   1. Same-author recent messages in the same channel (catches the Liz cluster)
//   2. Same-author recent messages in OTHER channels (catches "this person is
//      doing the same thing across the company")
//   3. Phrase-similar recent messages in the same channel from any author
//      (catches "different people raising the same issue")
//   4. Activity counts for context ("this person rarely posts" vs "habitual")
//
// The whole bundle stays under ~400 tokens worst-case so Haiku stays cheap.

const SAME_AUTHOR_LOOKBACK_DAYS = 30;
const PHRASE_LOOKBACK_DAYS = 30;
const PHRASE_PREFIX_LEN = 60; // chars of message used as the LIKE substring
const MAX_AUTHOR_SAME_CHANNEL = 5;
const MAX_AUTHOR_OTHER_CHANNELS = 3;
const MAX_PHRASE_MATCHES = 4;

function isoDaysAgo(days, fromIso) {
  const from = fromIso ? new Date(fromIso) : new Date();
  return new Date(from.getTime() - days * 86400000).toISOString();
}

// Strip <@U…|name> mentions and URLs to get a cleaner phrase to search on.
function stripMentionsAndUrls(text) {
  if (!text) return "";
  return text
    .replace(/<@U[A-Z0-9]+(?:\|[^>]*)?>/g, "")
    .replace(/<https?:\/\/[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pickPhraseSubstring(text) {
  const cleaned = stripMentionsAndUrls(text);
  if (cleaned.length < 12) return null; // too short to be a meaningful pattern
  return cleaned.slice(0, PHRASE_PREFIX_LEN).toLowerCase();
}

// Returns { same_channel_by_author, other_channels_by_author,
//           phrase_matches_same_channel, author_30d_count, channel_total_count }
export function buildRetrievalBundle(db, message) {
  const channelId = message.slack_channel_id;
  const ts = message.slack_ts;
  const authorId = message.author_slack_user_id ?? null;
  const postedAt = message.message_posted_at;
  const sinceAuthor = isoDaysAgo(SAME_AUTHOR_LOOKBACK_DAYS, postedAt);
  const sincePhrase = isoDaysAgo(PHRASE_LOOKBACK_DAYS, postedAt);

  let sameChannelByAuthor = [];
  let otherChannelsByAuthor = [];
  let author30dCount = 0;
  if (authorId) {
    sameChannelByAuthor = db.prepare(`
      SELECT m.slack_ts, m.message_posted_at, SUBSTR(m.text, 1, 180) AS preview
      FROM messages m
      WHERE m.author_slack_user_id = ?
        AND m.slack_channel_id = ?
        AND m.slack_ts != ?
        AND m.message_posted_at >= ?
        AND (m.message_posted_at <= ? OR ? IS NULL)
      ORDER BY m.message_posted_at DESC
      LIMIT ?
    `).all(authorId, channelId, ts, sinceAuthor, postedAt, postedAt, MAX_AUTHOR_SAME_CHANNEL);

    otherChannelsByAuthor = db.prepare(`
      SELECT m.slack_ts, m.message_posted_at, c.name AS channel,
             SUBSTR(m.text, 1, 160) AS preview
      FROM messages m
      JOIN channels c ON c.slack_channel_id = m.slack_channel_id
      WHERE m.author_slack_user_id = ?
        AND m.slack_channel_id != ?
        AND m.message_posted_at >= ?
        AND (m.message_posted_at <= ? OR ? IS NULL)
      ORDER BY m.message_posted_at DESC
      LIMIT ?
    `).all(authorId, channelId, sinceAuthor, postedAt, postedAt, MAX_AUTHOR_OTHER_CHANNELS);

    const cnt = db.prepare(`
      SELECT COUNT(*) AS n
      FROM messages
      WHERE author_slack_user_id = ?
        AND message_posted_at >= ?
    `).get(authorId, sinceAuthor);
    author30dCount = cnt?.n ?? 0;
  }

  // Phrase match: distinctive substring of *this* message, search the same channel
  // for other messages containing it. Excludes self.
  let phraseMatches = [];
  const phrase = pickPhraseSubstring(message.text);
  if (phrase) {
    phraseMatches = db.prepare(`
      SELECT m.slack_ts, m.message_posted_at, m.author_slack_user_id,
             v.full_name AS author, v.is_corporate, v.department_or_function,
             SUBSTR(m.text, 1, 180) AS preview
      FROM messages m
      LEFT JOIN v_employees_with_slack v ON v.slack_user_id = m.author_slack_user_id
      WHERE m.slack_channel_id = ?
        AND m.slack_ts != ?
        AND m.message_posted_at >= ?
        AND (m.message_posted_at <= ? OR ? IS NULL)
        AND LOWER(m.text) LIKE ?
      ORDER BY m.message_posted_at DESC
      LIMIT ?
    `).all(channelId, ts, sincePhrase, postedAt, postedAt, "%" + phrase + "%", MAX_PHRASE_MATCHES);
  }

  return {
    same_channel_by_author: sameChannelByAuthor,
    other_channels_by_author: otherChannelsByAuthor,
    phrase_matches_same_channel: phraseMatches,
    author_30d_count: author30dCount,
    phrase_used: phrase,
  };
}

// Render the bundle as plain text for injection into the Haiku user message.
export function renderRetrievalBundle(bundle) {
  const lines = [];
  lines.push("Cross-message retrieval (last 30 days):");

  if (bundle.author_30d_count != null) {
    lines.push(`  This author has posted ${bundle.author_30d_count} message(s) in the last 30 days across all observed channels.`);
  }

  if (bundle.same_channel_by_author?.length) {
    lines.push("  Recent messages by THIS AUTHOR in this channel:");
    for (const r of bundle.same_channel_by_author) {
      lines.push(`    [${r.message_posted_at}] ${r.preview}${r.preview.length >= 180 ? "…" : ""}`);
    }
  } else {
    lines.push("  No prior messages from this author in this channel within 30 days.");
  }

  if (bundle.other_channels_by_author?.length) {
    lines.push("  Recent messages by THIS AUTHOR in OTHER channels:");
    for (const r of bundle.other_channels_by_author) {
      lines.push(`    [${r.message_posted_at}] #${r.channel}: ${r.preview}${r.preview.length >= 160 ? "…" : ""}`);
    }
  }

  if (bundle.phrase_matches_same_channel?.length) {
    lines.push(`  Phrase-similar messages in this channel (matching "${bundle.phrase_used.slice(0, 40)}…"):`);
    for (const r of bundle.phrase_matches_same_channel) {
      const who = r.author ?? r.author_slack_user_id ?? "?";
      const role = r.is_corporate == null ? "" : (r.is_corporate ? " [Corp]" : " [Field]");
      lines.push(`    [${r.message_posted_at}] ${who}${role}: ${r.preview}${r.preview.length >= 180 ? "…" : ""}`);
    }
  } else if (bundle.phrase_used) {
    lines.push("  No other messages in this channel match the opening phrase pattern.");
  }

  return lines.join("\n");
}
