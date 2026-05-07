// Slack write-side API helpers (chat.postMessage, conversations.open).
// Read helpers stay in slack-api.mjs.
//
// Token priority for writes:
//   1. SLACK_BOT_TOKEN_BOT   (xoxb-... bot token, after admin approval)
//   2. SLACK_BOT_TOKEN       (xoxp-... user token — works as fallback for
//                             chat.postMessage; messages will appear as
//                             coming from the user, not a bot identity)
//
// Once an admin approves the bot install, you drop SLACK_BOT_TOKEN_BOT into
// .env.local and writes automatically switch to the bot identity. No code
// change needed.

import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv();

const BASE = "https://slack.com/api";

function getWriteToken() {
  const bot = process.env.SLACK_BOT_TOKEN_BOT;
  const user = process.env.SLACK_BOT_TOKEN;
  const token = bot || user;
  if (!token) {
    throw new Error("Need SLACK_BOT_TOKEN_BOT (preferred) or SLACK_BOT_TOKEN in .env.local for writes.");
  }
  return { token, kind: bot ? "bot" : "user" };
}

async function call(method, params = {}, { method_http = "POST" } = {}) {
  const { token } = getWriteToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json; charset=utf-8",
  };
  const init = { method: method_http, headers };
  if (method_http === "POST") init.body = JSON.stringify(params);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const resp = await fetch(`${BASE}/${method}`, init);
    if (resp.status === 429) {
      const wait = Number(resp.headers.get("retry-after") ?? 1);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const json = await resp.json();
    if (!json.ok) {
      const err = new Error(`Slack ${method} failed: ${json.error}`);
      err.slack_error = json.error;
      err.response = json;
      throw err;
    }
    return json;
  }
  throw new Error(`Slack ${method} retried 5 times without success`);
}

// Open a 1:1 IM with a user. Returns the channel ID (e.g., "D012345").
// If the IM already exists, Slack returns the same channel id.
export async function openIm(userId) {
  const res = await call("conversations.open", { users: userId });
  return res.channel?.id;
}

// Post a message. `blocks` is Block Kit JSON; `text` is the plaintext fallback.
// Returns { ts, channel } so the caller can record the bot_message_ts.
export async function postMessage({ channel, text, blocks, threadTs }) {
  const params = { channel, text };
  if (blocks) params.blocks = blocks;
  if (threadTs) params.thread_ts = threadTs;
  const res = await call("chat.postMessage", params);
  return { ts: res.ts, channel: res.channel };
}

// Convenience: which token is being used for writes (lets the digest sender
// log it so the user sees whether they're on bot or user identity).
export function getWriteTokenKind() {
  try { return getWriteToken().kind; } catch { return "missing"; }
}

// Resolve a canonical permalink for a Slack message. Works for both web
// and desktop-app deep links — Slack handles routing.
export async function getPermalink({ channel, message_ts }) {
  // chat.getPermalink is GET, not POST.
  const { token } = getWriteToken();
  const params = new URLSearchParams({ channel, message_ts });
  const resp = await fetch(`${BASE}/chat.getPermalink?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const json = await resp.json();
  if (!json.ok) {
    const err = new Error(`Slack chat.getPermalink failed: ${json.error}`);
    err.slack_error = json.error;
    throw err;
  }
  return json.permalink;
}

// Update an already-posted message in place (chat.update). Bot can edit
// messages it sent without re-notifying the recipient.
export async function updateMessage({ channel, ts, text, blocks }) {
  const params = { channel, ts, text };
  if (blocks) params.blocks = blocks;
  const res = await call("chat.update", params);
  return { ts: res.ts, channel: res.channel };
}
