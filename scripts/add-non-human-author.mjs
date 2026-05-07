// Add a Slack user_id to the non_human_authors exclusion list. Used for AI
// chatbots posing as humans (e.g., Arnold in service channels), workflow
// bots that don't have is_bot=true, etc.
//
// Usage:
//   npm run nonhuman:add -- --slack-user-id UXXXXXXX --display-name "Arnold" --reason "AI chatbot"
//   npm run nonhuman:add -- --by-name "Arnold"          # search Slack and add
//   npm run nonhuman:list                               # see current list

import process from "node:process";
import { openDatabase, nowIso } from "./lib/db.mjs";
import { refreshNonHumanCache } from "./lib/humans-only.mjs";

function parseArgs(argv) {
  const args = { mode: "add", slackUserId: null, displayName: null, reason: null, byName: null };
  if (argv[2] === "list") args.mode = "list";
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--slack-user-id") args.slackUserId = argv[++i];
    else if (a === "--display-name") args.displayName = argv[++i];
    else if (a === "--reason") args.reason = argv[++i];
    else if (a === "--by-name") args.byName = argv[++i];
    else if (a === "list") args.mode = "list";
  }
  return args;
}

function listMode(db) {
  const rows = db.prepare("SELECT * FROM non_human_authors ORDER BY added_at DESC").all();
  console.log(JSON.stringify(rows, null, 2));
}

function addMode(db, args) {
  if (!args.slackUserId) {
    console.error("Need --slack-user-id Uxxxxx (or look it up first via Slack search)");
    process.exit(1);
  }
  const result = db.prepare(`
    INSERT INTO non_human_authors (slack_user_id, display_name, reason, added_at, added_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(slack_user_id) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, non_human_authors.display_name),
      reason = COALESCE(excluded.reason, non_human_authors.reason)
  `).run(args.slackUserId, args.displayName ?? null, args.reason ?? null, nowIso(), null);
  refreshNonHumanCache();
  console.log(JSON.stringify({ slack_user_id: args.slackUserId, changes: result.changes }, null, 2));
}

function main() {
  const args = parseArgs(process.argv);
  const db = openDatabase();

  // Seed Slackbot if not present (defensive — humans-only.mjs already hard-codes it).
  db.prepare(`
    INSERT INTO non_human_authors (slack_user_id, display_name, reason, added_at)
    VALUES ('USLACKBOT', 'Slackbot', 'Slack system bot', ?)
    ON CONFLICT(slack_user_id) DO NOTHING
  `).run(nowIso());

  if (args.mode === "list") return listMode(db);
  return addMode(db, args);
}

try { main(); } catch (e) { console.error(e instanceof Error ? e.stack : String(e)); process.exit(1); }
