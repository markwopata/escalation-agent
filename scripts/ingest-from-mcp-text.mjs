// One-shot ingester for the prototype: reads the text-formatted output of the
// Claude Code Slack MCP `slack_read_channel` tool and persists messages into
// the local SQLite DB. Used while we don't yet have a direct Slack API token.
//
// Usage:
//   node scripts/ingest-from-mcp-text.mjs <channel_id> < raw_mcp_output.txt
//
// The long-term ingester will consume Slack Web API JSON directly; this is
// strictly a bridge for the prototype.

import process from "node:process";
import { openDatabase } from "./lib/db.mjs";
import { upsertMessage, reconcileEmployeeLinks } from "./lib/slack-store.mjs";

const HEADER_RE =
  /^=== Message from (.+?) \((U[A-Z0-9]+|B[A-Z0-9]+)\) at (.+?) ===\s*$/;
const TS_RE = /^Message TS:\s*(\d+\.\d+)\s*$/;
const THREAD_RE = /^Thread:\s*(\d+)\s+replies/;
const REACTIONS_RE = /^Reactions:\s*(.+)$/;
const FILES_LINE_RE = /^Files:\s*/;

function parseReactions(line) {
  // "name (count), name2 (count2)"
  const out = [];
  for (const part of line.split(",")) {
    const m = /(\S+)\s*\((\d+)\)/.exec(part.trim());
    if (m) out.push({ name: m[1], count: Number(m[2]) });
  }
  return out;
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function parseMcpText(text) {
  const messages = [];
  const blocks = text.split(/^=== Message from /m);
  // first block is the channel header preamble; skip it
  for (let i = 1; i < blocks.length; i += 1) {
    const block = "=== Message from " + blocks[i];
    const lines = block.split("\n");
    const header = HEADER_RE.exec(lines[0]);
    if (!header) continue;
    const tsLine = TS_RE.exec(lines[1] ?? "");
    if (!tsLine) continue;

    const username = header[1].trim();
    const userId = header[2];
    const ts = tsLine[1];

    // Body lines until we run out, stripping trailing metadata lines.
    const bodyLines = [];
    let reactions = null;
    let isParent = false;
    let fileMode = false;
    for (let j = 2; j < lines.length; j += 1) {
      const line = lines[j];
      if (THREAD_RE.test(line)) {
        isParent = true;
        fileMode = false;
        continue;
      }
      const rx = REACTIONS_RE.exec(line);
      if (rx) {
        reactions = parseReactions(rx[1]);
        fileMode = false;
        continue;
      }
      if (FILES_LINE_RE.test(line)) {
        fileMode = true;
        continue;
      }
      if (fileMode) {
        // continuation lines belonging to Files: section
        if (/^\s*$/.test(line)) {
          fileMode = false;
        }
        continue;
      }
      bodyLines.push(line);
    }

    // Trim trailing blank lines.
    while (bodyLines.length && /^\s*$/.test(bodyLines[bodyLines.length - 1])) {
      bodyLines.pop();
    }

    const isBot = userId.startsWith("B");
    const message = {
      ts,
      user: userId,
      username,
      text: bodyLines.join("\n"),
      type: "message",
      // We can't tell from this format whether this is itself a thread reply
      // (we only see top-level channel listing). Use ts as thread_ts for parents,
      // null otherwise. Since slack_read_channel returns top-level messages only,
      // every row is a parent.
      thread_ts: ts,
      reply_count: isParent ? null : 0,
      reactions: reactions ?? undefined,
      ...(isBot ? { subtype: "bot_message", bot_id: userId } : {}),
    };
    messages.push(message);
  }
  return messages;
}

async function main() {
  const channelId = process.argv[2];
  if (!channelId) {
    console.error("Usage: node scripts/ingest-from-mcp-text.mjs <channel_id>");
    process.exit(1);
  }

  const text = await readStdin();
  if (!text.trim()) {
    console.error("No MCP text on stdin.");
    process.exit(1);
  }

  const messages = parseMcpText(text);
  if (!messages.length) {
    console.error("Parsed zero messages — input may not match expected format.");
    process.exit(1);
  }

  const db = openDatabase();
  const txn = db.transaction(() => {
    for (const m of messages) {
      upsertMessage(db, channelId, m);
    }
  });
  txn();

  const reconciled = reconcileEmployeeLinks(db);

  console.log(JSON.stringify({
    channel_id: channelId,
    ingested_messages: messages.length,
    reconciled,
  }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
