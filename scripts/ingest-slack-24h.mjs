// Slack N-hour backfill, multi-token edition.
//
// Builds a channel→token routing map using all configured user tokens
// (SLACK_TOKEN_MARK, SLACK_TOKEN_JABBOK, SLACK_TOKEN_WILLY, ...), then
// pulls history from each channel using whichever owner has membership.
// Result: union of every exec's Slack visibility.
//
// Usage:
//   node scripts/ingest-slack-24h.mjs                    # default 24h
//   node scripts/ingest-slack-24h.mjs --hours 168        # 7 days
//   node scripts/ingest-slack-24h.mjs --dry-run          # router build only
//   node scripts/ingest-slack-24h.mjs --channel-limit N

import process from "node:process";
import { openDatabase } from "./lib/db.mjs";
import { fetchMessages } from "./lib/slack-api.mjs";
import { upsertMessage } from "./lib/slack-store.mjs";
import { buildRouter } from "./lib/slack-token-router.mjs";

function parseArgs(argv) {
  const args = { hours: 24, dryRun: false, channelLimit: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--hours") args.hours = Number(argv[++i]);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--channel-limit") args.channelLimit = Number(argv[++i]);
  }
  return args;
}

function oldestTsForHours(hours) {
  return String((Date.now() / 1000) - hours * 3600);
}

async function main() {
  const args = parseArgs(process.argv);
  const db = openDatabase();
  const oldestTs = oldestTsForHours(args.hours);
  const sinceIso = new Date(Date.now() - args.hours * 3600 * 1000).toISOString();
  console.log(`Slack ${args.hours}h backfill (since ${sinceIso})${args.dryRun ? " [DRY RUN]" : ""}`);
  console.log("---");

  console.log("[1/2] Building token router (this also enumerates + upserts channels)...");
  const router = await buildRouter(db, { types: "public_channel,private_channel" });
  let accessibleChannels = router.accessibleChannels();
  console.log(`  Router has ${accessibleChannels.length} channels with at least one member-token.`);
  if (args.channelLimit) accessibleChannels = accessibleChannels.slice(0, args.channelLimit);

  if (args.dryRun) return;

  console.log(`[2/2] Pulling last ${args.hours}h messages from each accessible channel...`);
  let total = 0;
  let withMessages = 0;
  let errors = 0;
  let i = 0;
  // Group by token-owner so we get nice cumulative output per owner.
  const byOwner = new Map();
  for (const cid of accessibleChannels) {
    const owner = router.tokenForChannel(cid);
    if (!owner) continue;
    if (!byOwner.has(owner.name)) byOwner.set(owner.name, []);
    byOwner.get(owner.name).push(cid);
  }
  for (const [ownerName, cids] of byOwner) {
    console.log(`  via ${ownerName}: ${cids.length} channels`);
  }

  for (const cid of accessibleChannels) {
    i += 1;
    const owner = router.tokenForChannel(cid);
    if (!owner) continue;
    let count = 0;
    try {
      const buffered = [];
      for await (const m of fetchMessages(cid, oldestTs, { token: owner.token })) {
        buffered.push(m);
      }
      const txn = db.transaction(() => {
        for (const m of buffered) {
          upsertMessage(db, cid, m);
          count += 1;
        }
      });
      txn();
      total += count;
      if (count > 0) withMessages += 1;
    } catch (err) {
      const benign = /not_in_channel|channel_not_found|missing_scope/.test(err.message ?? "");
      if (!benign) {
        errors += 1;
        console.error(`  [${i}/${accessibleChannels.length}] ${cid} (via ${owner.name}): ${err.message}`);
      }
    }
    if (i % 200 === 0 || i === accessibleChannels.length) {
      console.log(`  [${i}/${accessibleChannels.length}] cumulative: ${total} messages from ${withMessages} channels (${errors} errors)`);
    }
  }
  console.log(`---\nSlack backfill done: ${total} messages from ${withMessages}/${accessibleChannels.length} channels.`);
  const dbCount = db.prepare("SELECT COUNT(*) AS n FROM messages").get();
  console.log(`Local DB now holds: ${dbCount.n} total Slack messages.`);
}

await main();
