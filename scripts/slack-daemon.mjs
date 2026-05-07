// Slack ingestion daemon. Polls Slack for new messages and persists them
// via the existing slack-store helpers. Designed to be run on a schedule
// (cron, systemd timer, etc.) — NOT a long-lived process.
//
// Each invocation:
//   1. Refreshes channel list (paginated)
//   2. For each channel: pulls messages since the latest stored slack_ts
//   3. Resolves new authors' Slack profiles (lazy, by user_id)
//   4. Reconciles slack_users → employees by email
//
// Recommended cadence (cron):
//   */15 * * * *  cd /path/to/repo && npm run daemon:slack
//
// Or for low-priority channels, every hour. Channels.ingestion_priority
// drives the cadence (left to the orchestrator).
//
// Usage:
//   npm run daemon:slack                   # ingest all channels
//   npm run daemon:slack -- --channels C1,C2  # specific channels only
//   npm run daemon:slack -- --since 2026-04-20 # explicit floor (override per-channel last-seen)

import process from "node:process";
import { openDatabase, nowIso } from "./lib/db.mjs";
import {
  upsertChannel,
  upsertMessage,
  upsertSlackUser,
  reconcileEmployeeLinks,
} from "./lib/slack-store.mjs";
import { listChannels, fetchMessages, fetchUserProfile } from "./lib/slack-api.mjs";

function parseArgs(argv) {
  const args = { channels: null, since: null, refreshChannels: true };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--channels") args.channels = argv[++i].split(",");
    else if (a === "--since") args.since = argv[++i];
    else if (a === "--no-refresh-channels") args.refreshChannels = false;
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node scripts/slack-daemon.mjs [--channels C1,C2,...] [--since ISO] [--no-refresh-channels]");
      process.exit(0);
    }
  }
  return args;
}

function isoToSlackTs(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? (t / 1000).toFixed(6) : null;
}

async function refreshChannelList(db) {
  let n = 0;
  for await (const c of listChannels()) {
    upsertChannel(db, {
      id: c.id,
      name: c.name,
      channel_type: c.is_private ? "private_channel" : (c.is_im ? "im" : (c.is_mpim ? "mpim" : "public_channel")),
      is_archived: c.is_archived,
      topic: c.topic?.value,
      purpose: c.purpose?.value,
      creator_user_id: c.creator,
      created_ts: c.created ? new Date(c.created * 1000).toISOString() : null,
    });
    n += 1;
  }
  console.log(`Refreshed ${n} channels.`);
  return n;
}

function lastIngestedTs(db, channelId) {
  const row = db.prepare(`
    SELECT MAX(slack_ts) AS m FROM messages WHERE slack_channel_id = ?
  `).get(channelId);
  return row?.m ?? null;
}

async function ingestChannel(db, channelId, oldestOverride) {
  const oldest = oldestOverride ?? lastIngestedTs(db, channelId);
  let count = 0, newAuthors = 0;
  const seenAuthors = new Set();
  for await (const msg of fetchMessages(channelId, oldest)) {
    upsertMessage(db, channelId, msg);
    count += 1;
    if (msg.user && !seenAuthors.has(msg.user)) {
      seenAuthors.add(msg.user);
      // Lazy profile fetch only for users we don't have email for yet.
      const existing = db.prepare(`SELECT email FROM slack_users WHERE slack_user_id = ?`).get(msg.user);
      if (!existing?.email) {
        try {
          const profile = await fetchUserProfile(msg.user);
          if (profile) {
            upsertSlackUser(db, {
              slack_user_id: profile.id,
              username: profile.name,
              real_name: profile.real_name ?? profile.profile?.real_name,
              display_name: profile.profile?.display_name,
              email: profile.profile?.email,
              title: profile.profile?.title,
              timezone: profile.tz,
              is_bot: profile.is_bot,
              is_restricted: profile.is_restricted,
              is_deleted: profile.deleted,
              profile_fetched_at: nowIso(),
            });
            newAuthors += 1;
          }
        } catch (err) {
          console.warn(`Could not fetch profile for ${msg.user}: ${err.message}`);
        }
      }
    }
  }
  return { count, newAuthors };
}

async function main() {
  const args = parseArgs(process.argv);
  const db = openDatabase();

  if (args.refreshChannels && !args.channels) {
    await refreshChannelList(db);
  }

  const targetChannels = args.channels ?? db.prepare(`
    SELECT slack_channel_id FROM channels WHERE is_archived = 0
  `).all().map(r => r.slack_channel_id);

  const oldest = args.since ? isoToSlackTs(args.since) : null;
  let totalMessages = 0, totalAuthors = 0;
  for (const channelId of targetChannels) {
    try {
      const { count, newAuthors } = await ingestChannel(db, channelId, oldest);
      console.log(`#${channelId}: +${count} messages, +${newAuthors} new author profiles`);
      totalMessages += count;
      totalAuthors += newAuthors;
    } catch (err) {
      console.error(`Error on channel ${channelId}: ${err.message}`);
    }
  }
  console.log(`\nTotal: +${totalMessages} messages, +${totalAuthors} authors across ${targetChannels.length} channels.`);

  const reconciled = reconcileEmployeeLinks(db);
  console.log(`Email-link reconciliation: resolved ${reconciled.resolved} of ${reconciled.candidates_examined} candidate(s).`);
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
}
