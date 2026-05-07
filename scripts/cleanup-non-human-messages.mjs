// Removes existing non-human messages from the DB and all dependent rows.
// Idempotent. Run after updating the humans-only rules or adding new
// authors to non_human_authors.
//
// Cascades:
//   - message_entities (FK CASCADE)
//   - ceo_interventions (FK CASCADE)
//   - triage_runs (FK CASCADE)
//   - investigations follow triage_runs (their FK chain handles it)
//
// Usage:
//   npm run nonhuman:cleanup           # delete + report
//   npm run nonhuman:cleanup -- --dry-run

import process from "node:process";
import { openDatabase } from "./lib/db.mjs";
import { classifyAsNonHuman } from "./lib/humans-only.mjs";

const args = { dryRun: false };
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === "--dry-run") args.dryRun = true;
}

const db = openDatabase();
const messages = db.prepare("SELECT * FROM messages").all();
let toDelete = 0;
const reasonCounts = new Map();
const targets = [];
for (const m of messages) {
  // Reconstruct an envelope-shape that classifyAsNonHuman recognizes.
  const envelope = {
    is_bot: m.is_bot === 1,
    bot_id: null,
    subtype: m.subtype,
    user: m.author_slack_user_id,
    user_id: m.author_slack_user_id,
    author_slack_user_id: m.author_slack_user_id,
  };
  const nonHuman = classifyAsNonHuman(envelope, db);
  if (nonHuman) {
    toDelete += 1;
    reasonCounts.set(nonHuman.reason, (reasonCounts.get(nonHuman.reason) ?? 0) + 1);
    targets.push({ ch: m.slack_channel_id, ts: m.slack_ts });
  }
}

console.log(`Found ${toDelete} non-human messages out of ${messages.length} total.`);
console.log("Reasons:", Object.fromEntries(reasonCounts));

if (args.dryRun) {
  console.log("DRY RUN — no deletions performed.");
  process.exit(0);
}

const txn = db.transaction(() => {
  const stmt = db.prepare("DELETE FROM messages WHERE slack_channel_id = ? AND slack_ts = ?");
  for (const t of targets) stmt.run(t.ch, t.ts);
});
txn();

console.log(`Deleted ${toDelete} non-human messages.`);
console.log("Remaining messages:", db.prepare("SELECT COUNT(*) AS n FROM messages").get().n);
console.log("Remaining triage_runs:", db.prepare("SELECT COUNT(*) AS n FROM triage_runs").get().n);
console.log("Remaining ceo_interventions:", db.prepare("SELECT COUNT(*) AS n FROM ceo_interventions").get().n);
console.log("Remaining message_entities:", db.prepare("SELECT COUNT(*) AS n FROM message_entities").get().n);
