// Ingests Slack payloads (channel meta, messages, user profiles) into the
// local SQLite store, then reconciles employee links by email.
//
// Reads a single JSON envelope from stdin:
//
//   { "type": "channel",   "payload": { ...channel fields... } }
//   { "type": "messages",  "payload": { "channel_id": "C...", "messages": [...] } }
//   { "type": "user",      "payload": { ...slack user profile fields... } }
//   { "type": "batch",     "payload": [ <envelope>, <envelope>, ... ] }
//   { "type": "reconcile", "payload": null }
//
// Always runs reconcileEmployeeLinks at the end so any new emails get matched.

import process from "node:process";
import { openDatabase } from "./lib/db.mjs";
import {
  upsertChannel,
  upsertMessage,
  upsertSlackUser,
  reconcileEmployeeLinks,
} from "./lib/slack-store.mjs";

async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function processEnvelope(db, envelope) {
  const { type, payload } = envelope;
  switch (type) {
    case "channel":
      upsertChannel(db, payload);
      return { kind: "channel", id: payload.id ?? payload.slack_channel_id };
    case "messages": {
      const { channel_id, messages = [] } = payload;
      if (!channel_id) throw new Error("messages payload missing channel_id");
      let n = 0;
      for (const msg of messages) {
        upsertMessage(db, channel_id, msg);
        n += 1;
      }
      return { kind: "messages", channel_id, count: n };
    }
    case "user":
      upsertSlackUser(db, payload);
      return { kind: "user", id: payload.slack_user_id ?? payload.id };
    case "batch": {
      const results = [];
      for (const inner of payload) {
        results.push(processEnvelope(db, inner));
      }
      return { kind: "batch", count: results.length, items: results };
    }
    case "reconcile":
      return { kind: "reconcile" };
    default:
      throw new Error(`unknown envelope type: ${type}`);
  }
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) {
    console.error("No JSON on stdin.");
    process.exit(1);
  }
  const envelope = JSON.parse(raw);

  const db = openDatabase();
  const txn = db.transaction(() => processEnvelope(db, envelope));
  const result = txn();

  const reconciled = reconcileEmployeeLinks(db);
  console.log(JSON.stringify({ result, reconciled }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
