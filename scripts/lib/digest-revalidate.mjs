// Digest-time re-validation.
//
// Tier B runs are async: a triage flag from N hours ago goes through
// investigation, rollup, and only THEN reaches the digest. In the meantime,
// the underlying thread may have been resolved. The most embarrassing failure
// mode: an escalation that says "thread has no reply / unrouted / unanswered"
// when by delivery time the thread has been actively routed and replied to.
//
// This module re-checks each Slack-sourced escalation against current thread
// state via Slack's conversations.replies API just before delivery. If the
// "thread is dead" claim has been falsified, we drop the escalation. For
// other escalations we annotate the delivery with current thread state so
// the recipient can see "yes, this is still relevant" or "yes, but it's
// already getting a response."
//
// Why only Slack: Front data is refreshed hourly via Snowflake, so the
// stored thread state IS the current state from a digest perspective. There
// is no parallel "live API" to re-check Front against the way Slack has.
//
// Cost: ~6 escalations per digest run × 1 conversations.replies call each =
// trivial. Tier 4 rate limit = 100/min. Token resolution goes through
// slack-token-router so we hit channels we can actually read.

import { fetchThread } from "./slack-api.mjs";

// Pull recent channel messages between two timestamps. Mirrors fetchThread
// but uses conversations.history instead of conversations.replies. We do this
// inline rather than adding to slack-api.mjs because the use case is narrow
// (only digest revalidation needs it). Returns the raw message envelopes.
//
// Retries on 429 rate-limit and on transient `ratelimited` JSON errors —
// without retry, a single rate-limited call returns empty channel history,
// which masquerades as "no engagement" and produces wrong revalidation
// results (the "shouldDrop=false on engaged thread" bug seen 2026-05-01).
async function fetchChannelHistoryBetween(channelId, oldestTs, latestTs, token) {
  const out = [];
  let cursor;
  const MAX_ATTEMPTS = 5;
  while (true) {
    const params = new URLSearchParams({
      channel: channelId,
      oldest: oldestTs,
      latest: latestTs,
      limit: "200",
      inclusive: "false",
      ...(cursor ? { cursor } : {}),
    });
    const url = `https://slack.com/api/conversations.history?${params.toString()}`;
    let json = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (resp.status === 429) {
        const wait = Number(resp.headers.get("retry-after") ?? 1);
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }
      json = await resp.json();
      if (json.ok) break;
      if (json.error === "ratelimited") {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      const err = new Error(`conversations.history failed: ${json.error}`);
      err.slack_error = json.error;
      throw err;
    }
    if (!json?.ok) {
      const err = new Error(`conversations.history retried ${MAX_ATTEMPTS}x without ok`);
      err.slack_error = json?.error ?? "unknown";
      throw err;
    }
    out.push(...(json.messages ?? []));
    cursor = json.response_metadata?.next_cursor;
    if (!cursor || !json.has_more) break;
  }
  return out;
}

// Phrases that, when present in an escalation's summary, mean the
// escalation's premise is "no one answered" / "no engagement". If we see
// any of these AND the thread now has replies, drop the escalation —
// the premise is falsified.
const DEAD_AIR_PHRASES = [
  /\bno\s+reply\b/i,
  /\bno\s+response\b/i,
  /\bunanswered\b/i,
  /\bunrouted\b/i,
  /\bnot\s+routed\b/i,
  /\bsilent\b/i,
  /\bignored\b/i,
  /\bstill\s+waiting\b/i,
  /\bwithout\s+(?:a\s+)?reply\b/i,
  /\bdead\s+air\b/i,
  /\bthread\s+has\s+no\b/i,
  /\bnobody\s+(?:has\s+)?(?:replied|responded|answered)\b/i,
  /\bno\s+one\s+(?:has\s+)?(?:replied|responded|answered)\b/i,
];

function summaryClaimsDeadAir(esc) {
  const text = `${esc.representative_exec_summary ?? ""} ${esc.display_title_short_summary ?? ""} ${esc.display_title ?? ""}`;
  return DEAD_AIR_PHRASES.some(rx => rx.test(text));
}

// Resolve (channel_id, parent_ts) for a Slack escalation by joining through
// the representative investigation. Returns null if we can't resolve (e.g.
// the escalation was Slack-sourced but the underlying triage_run is gone).
function resolveSlackParent(db, esc) {
  const invId = esc.representative_investigation_id;
  if (!invId) return null;
  return db.prepare(`
    SELECT t.slack_channel_id, t.slack_ts
    FROM investigations i
    JOIN triage_runs t ON t.id = i.triage_run_id
    WHERE i.id = ?
  `).get(invId) ?? null;
}

// Re-check one Slack escalation. Returns:
//   { shouldDrop: bool, dropReason: string | null,
//     replyCount: number, latestReplyTsIso: string | null,
//     latestReplyAuthor: string | null,
//     statusNote: string }
//
// If we can't reach the thread (no token, channel not accessible, etc.)
// we DON'T drop — better to over-deliver than to silently swallow real
// escalations. We just return shouldDrop=false and a note explaining why.
export async function revalidateSlackEscalation(db, esc, router) {
  if (esc.source !== "slack") {
    return { shouldDrop: false, dropReason: null, replyCount: null, latestReplyTsIso: null, latestReplyAuthor: null, statusNote: "" };
  }
  const parent = resolveSlackParent(db, esc);
  if (!parent) {
    return { shouldDrop: false, dropReason: null, replyCount: null, latestReplyTsIso: null, latestReplyAuthor: null, statusNote: "(could not resolve parent message for revalidation)" };
  }
  const tokenInfo = router?.tokenForChannel?.(parent.slack_channel_id);
  if (!tokenInfo) {
    return { shouldDrop: false, dropReason: null, replyCount: null, latestReplyTsIso: null, latestReplyAuthor: null, statusNote: `(no token routes to ${parent.slack_channel_id} — could not revalidate)` };
  }
  let messages;
  try {
    messages = await fetchThread(parent.slack_channel_id, parent.slack_ts, { token: tokenInfo.token });
  } catch (err) {
    return { shouldDrop: false, dropReason: null, replyCount: null, latestReplyTsIso: null, latestReplyAuthor: null, statusNote: `(thread fetch failed: ${err.slack_error ?? err.message})` };
  }
  // First message is the parent; remainder are replies.
  const replies = messages.slice(1);
  const replyCount = replies.length;
  const latestReply = replies[replies.length - 1];
  const latestReplyTsIso = latestReply ? new Date(Number(latestReply.ts) * 1000).toISOString() : null;
  // Author is a slack_user_id; resolve to name via v_employees_with_slack
  // so the headline can render "Willy Schlacks @ 4:58" not just U-string.
  function resolveName(uid) {
    if (!uid) return null;
    const row = db.prepare(`SELECT full_name FROM v_employees_with_slack WHERE slack_user_id = ?`).get(uid);
    return row?.full_name ?? uid;
  }
  const latestReplyAuthor = resolveName(latestReply?.user);

  // Also pull subsequent channel-history messages within 4h after the parent.
  // EquipmentShare's field channels (gc-*, dc-*, help-*) often route a request
  // by posting NEW top-level messages instead of using thread replies — so an
  // empty thread can coexist with a fully-engaged conversation in the channel.
  // Window is 4h to align with the dead-air recency floor: if engagement
  // happened within 4h, the request was being actively addressed.
  const parentTsNum = Number(parent.slack_ts);
  const windowEnd = (parentTsNum + 4 * 3600).toString(); // +4h
  let subsequentMessages = [];
  let subsequentFetchError = null;
  try {
    subsequentMessages = await fetchChannelHistoryBetween(parent.slack_channel_id, parent.slack_ts, windowEnd, tokenInfo.token);
  } catch (err) {
    subsequentFetchError = err.slack_error ?? err.message;
  }
  // Distinct authors other than the parent author. Bot/system messages have
  // bot_id but no user — exclude them since they aren't real engagement.
  const parentAuthor = messages[0]?.user;
  const distinctOtherAuthors = new Set();
  let latestSubsequentTsIso = null;
  let latestSubsequentAuthor = null;
  for (const m of subsequentMessages) {
    if (!m.user) continue;
    if (m.user === parentAuthor) continue;
    distinctOtherAuthors.add(m.user);
    const tsIso = new Date(Number(m.ts) * 1000).toISOString();
    if (!latestSubsequentTsIso || tsIso > latestSubsequentTsIso) {
      latestSubsequentTsIso = tsIso;
      latestSubsequentAuthor = resolveName(m.user);
    }
  }
  const subsequentEngagement = distinctOtherAuthors.size;

  // Drop conditions:
  //   (1) primary_criterion is help_channel_dead_air AND (replies >= 1 OR subsequent engagement)
  //   (2) summary claims dead-air via DEAD_AIR_PHRASES AND (replies >= 1 OR subsequent engagement >= 2 distinct authors)
  // The "2 distinct authors" floor on channel engagement avoids false drops
  // from a single follow-up "?" or unrelated post — real routing engages
  // multiple people quickly.
  let shouldDrop = false;
  let dropReason = null;
  const claimsDeadAir = summaryClaimsDeadAir(esc);
  const isDeadAirCriterion = esc.primary_criterion === "help_channel_dead_air" || esc.primary_criterion === "help_channel_dead_air_expansion";

  if (replyCount >= 1 && (isDeadAirCriterion || claimsDeadAir)) {
    shouldDrop = true;
    dropReason = `${isDeadAirCriterion ? "dead-air premise" : "summary's no-reply claim"} falsified: thread now has ${replyCount} repl${replyCount === 1 ? "y" : "ies"} (latest by ${latestReplyAuthor ?? "?"} at ${latestReplyTsIso?.slice(0, 16).replace("T", " ")})`;
  } else if (subsequentEngagement >= 2 && (isDeadAirCriterion || claimsDeadAir)) {
    shouldDrop = true;
    dropReason = `${isDeadAirCriterion ? "dead-air premise" : "summary's no-reply claim"} falsified: ${subsequentEngagement} other authors posted in channel within 4h of parent (latest by ${latestSubsequentAuthor ?? "?"} at ${latestSubsequentTsIso?.slice(0, 16).replace("T", " ")})`;
  }
  // Broader "active engagement is a counter-signal" rule — applies regardless
  // of the summary's framing. The premise of any escalation is that exec
  // attention is needed; substantial multi-author engagement falsifies that
  // premise even if the summary doesn't explicitly claim "no reply."
  // Thresholds chosen to require real engagement, not single follow-up:
  //   - >=5 thread replies, OR
  //   - >=3 distinct other authors in channel-history within 4h, OR
  //   - >=2 thread replies AND ALL replies within 1h of parent (fast-resolve
  //     pattern — e.g. #5141 T3 CC parts: parent at 21:56, 3 replies done by
  //     22:13, field handled inside 17min; not exec territory)
  // Field doing their job in a project channel = field has ownership = exec
  // doesn't need to step in unless it stalls. If it does stall, the next
  // digest's revalidation will see the engagement go quiet and re-deliver.
  const parentTsNumForFast = Number(parent.slack_ts);
  const oneHourAfterParent = parentTsNumForFast + 3600;
  const fastResolveAllRepliesWithin1h = replyCount >= 2 && replies.every(r => Number(r.ts) <= oneHourAfterParent);

  if (!shouldDrop && (replyCount >= 5 || subsequentEngagement >= 3 || fastResolveAllRepliesWithin1h)) {
    shouldDrop = true;
    if (replyCount >= 5) {
      dropReason = `active engagement counter-signal: thread has ${replyCount} replies (latest by ${latestReplyAuthor ?? "?"} at ${latestReplyTsIso?.slice(0, 16).replace("T", " ")}) — field has ownership`;
    } else if (fastResolveAllRepliesWithin1h) {
      const minutesToLatest = Math.round((Number(latestReply.ts) - parentTsNumForFast) / 60);
      dropReason = `fast-resolve counter-signal: thread had ${replyCount} replies within ${minutesToLatest}min of parent (latest by ${latestReplyAuthor ?? "?"}) — field handled it immediately`;
    } else {
      dropReason = `active engagement counter-signal: ${subsequentEngagement} other authors engaged in channel within 4h of parent (latest by ${latestSubsequentAuthor ?? "?"} at ${latestSubsequentTsIso?.slice(0, 16).replace("T", " ")}) — field has ownership`;
    }
  }

  // Status note for non-dropped escalations: tell the recipient what the
  // current thread + channel state looks like so they can see if it's still
  // genuinely stuck.
  let statusNote = "";
  if (!shouldDrop) {
    const parts = [];
    if (replyCount > 0) {
      parts.push(`${replyCount} thread repl${replyCount === 1 ? "y" : "ies"} (latest by ${latestReplyAuthor ?? "?"} at ${latestReplyTsIso?.slice(0, 16).replace("T", " ")})`);
    } else {
      parts.push("0 thread replies");
    }
    if (subsequentFetchError) {
      parts.push(`channel-history fetch failed: ${subsequentFetchError}`);
    } else if (subsequentEngagement > 0) {
      parts.push(`${subsequentEngagement} other author${subsequentEngagement === 1 ? "" : "s"} posted in channel within 4h (latest by ${latestSubsequentAuthor ?? "?"} at ${latestSubsequentTsIso?.slice(0, 16).replace("T", " ")})`);
    } else {
      parts.push("no channel activity within 4h of parent");
    }
    statusNote = `_revalidated at digest time: ${parts.join("; ")}_`;
  }

  return {
    shouldDrop, dropReason,
    replyCount, latestReplyTsIso, latestReplyAuthor,
    subsequentEngagement, latestSubsequentTsIso, latestSubsequentAuthor,
    statusNote,
  };
}

// Persist the result of revalidation for analytics / audit.
export function recordRevalidation(db, escalation_id, result) {
  db.prepare(`
    INSERT INTO digest_revalidations (
      escalation_id, checked_at, reply_count, latest_reply_ts, latest_reply_author,
      should_drop, drop_reason, status_note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    escalation_id,
    new Date().toISOString(),
    result.replyCount,
    result.latestReplyTsIso,
    result.latestReplyAuthor,
    result.shouldDrop ? 1 : 0,
    result.dropReason,
    result.statusNote || null,
  );
}
