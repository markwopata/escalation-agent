// Thin wrapper around the Slack Web API for the daemon and ingest scripts.
//
// Multi-token model: every function accepts an optional `token` argument.
// If omitted, falls back to SLACK_TOKEN_MARK, then legacy SLACK_BOT_TOKEN.
// For multi-token routing (calling with whichever user-token has access
// to a given channel), use slack-token-router.mjs.
//
// Rate limits: Slack tier 2 = 20 req/min, tier 3 = 50 req/min, tier 4 =
// 100 req/min. We respect the Retry-After header on 429 responses.

import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv();

const BASE = "https://slack.com/api";

function resolveToken(explicit) {
  if (explicit) return explicit;
  const t = process.env.SLACK_TOKEN_MARK || process.env.SLACK_BOT_TOKEN;
  if (!t) {
    throw new Error("No Slack token available. Set SLACK_TOKEN_MARK (preferred) or SLACK_BOT_TOKEN in .env.local.");
  }
  return t;
}

async function call(method, params = {}, { method_http = "GET", token } = {}) {
  const tk = resolveToken(token);
  let url = `${BASE}/${method}`;
  let body = null;
  const headers = {
    Authorization: `Bearer ${tk}`,
    Accept: "application/json",
  };
  if (method_http === "GET") {
    const query = new URLSearchParams(params);
    if ([...query].length) url += "?" + query.toString();
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded; charset=utf-8";
    body = new URLSearchParams(params).toString();
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const resp = await fetch(url, { method: method_http, headers, body });
    if (resp.status === 429) {
      const wait = Number(resp.headers.get("retry-after") ?? 1);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const json = await resp.json();
    if (!json.ok) {
      const err = new Error(`Slack API ${method} failed: ${json.error}`);
      err.slack_error = json.error;
      err.response = json;
      throw err;
    }
    return json;
  }
  throw new Error(`Slack API ${method} retried 5 times without success`);
}

// Iterate over a paginated endpoint. yields each page's `key` array.
export async function* paginate(method, params, key, opts = {}) {
  let cursor;
  while (true) {
    const page = await call(method, { ...params, ...(cursor ? { cursor } : {}), limit: 200 }, opts);
    yield page[key] ?? [];
    cursor = page.response_metadata?.next_cursor;
    if (!cursor) return;
  }
}

// Defaults to public + private channels only. mpim/im (group + direct DMs)
// require additional scopes; pass them explicitly when those are granted.
// Returns the full channel object including is_member which is the routing key.
export async function* listChannels({ types = "public_channel,private_channel", excludeArchived = true, token } = {}) {
  for await (const page of paginate("conversations.list", { types, exclude_archived: excludeArchived }, "channels", { token })) {
    for (const c of page) yield c;
  }
}

// Fetch messages from `oldest` (ts as float-string) to now. Yields each message in chronological order.
export async function* fetchMessages(channelId, oldestTs, { token } = {}) {
  const params = { channel: channelId, inclusive: false };
  if (oldestTs) params.oldest = oldestTs;
  let cursor;
  const buffered = [];
  while (true) {
    const page = await call("conversations.history", { ...params, ...(cursor ? { cursor } : {}), limit: 200 }, { token });
    for (const m of page.messages ?? []) buffered.push(m);
    cursor = page.response_metadata?.next_cursor;
    if (!cursor || !page.has_more) break;
  }
  // Slack returns newest-first; flip to oldest-first.
  buffered.sort((a, b) => Number(a.ts) - Number(b.ts));
  for (const m of buffered) yield m;
}

export async function fetchUserProfile(userId, { token } = {}) {
  const json = await call("users.info", { user: userId }, { token });
  return json.user;
}

export async function fetchAuthTest({ token } = {}) {
  return call("auth.test", {}, { token });
}

// Fetch a single message by (channel, ts). Uses conversations.history with
// the ts as both bounds so Slack returns just that one message. Returns the
// raw message envelope (or null if not accessible).
export async function fetchSingleMessage(channelId, slackTs, { token } = {}) {
  const tk = resolveToken(token);
  const params = new URLSearchParams({
    channel: channelId,
    latest: slackTs,
    oldest: slackTs,
    inclusive: "true",
    limit: "1",
  });
  const resp = await fetch(`https://slack.com/api/conversations.history?${params.toString()}`, {
    headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" },
  });
  const json = await resp.json();
  if (!json.ok) {
    const err = new Error(`Slack conversations.history failed: ${json.error}`);
    err.slack_error = json.error;
    throw err;
  }
  return json.messages?.[0] ?? null;
}

export async function fetchThread(channelId, threadTs, { token } = {}) {
  const out = [];
  let cursor;
  while (true) {
    const page = await call("conversations.replies", {
      channel: channelId,
      ts: threadTs,
      ...(cursor ? { cursor } : {}),
      limit: 200,
    }, { token });
    out.push(...(page.messages ?? []));
    cursor = page.response_metadata?.next_cursor;
    if (!cursor || !page.has_more) break;
  }
  return out;
}
