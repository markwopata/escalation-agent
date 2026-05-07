// Multi-token Slack router.
//
// EquipmentShare's Slack workspace requires per-user membership for
// `conversations.history` even with admin-grade scopes (no Discovery API).
// We work around this by collecting user tokens from multiple execs (Mark,
// Jabbok, Will) and routing each channel pull to a token whose owner is a
// member of that channel.
//
// Usage:
//   const router = await buildRouter(db);
//   const tokenInfo = router.tokenForChannel(channelId);  // { name, token } | null
//   for (const [name, token] of router.allTokens()) { ... }   // iterate all tokens
//
// Side effects on build():
//   - Calls auth.test once per token to confirm identity
//   - Enumerates channels per token; persists membership to channel_token_access
//   - Skips tokens that fail auth.test (warns to stderr)

import { fetchAuthTest, listChannels } from "./slack-api.mjs";
import { upsertChannel } from "./slack-store.mjs";
import { nowIso } from "./db.mjs";

// Token owner names we accept via env. Add more here if you onboard another exec.
const KNOWN_OWNERS = ["mark", "jabbok", "willy"];

function loadTokenEnvs() {
  const tokens = [];
  for (const owner of KNOWN_OWNERS) {
    const tk = process.env[`SLACK_TOKEN_${owner.toUpperCase()}`];
    if (tk) tokens.push({ name: owner, token: tk });
  }
  return tokens;
}

async function identifyToken(t) {
  try {
    const r = await fetchAuthTest({ token: t.token });
    return { ...t, slack_user_id: r.user_id, slack_username: r.user };
  } catch (err) {
    console.error(`[router] token ${t.name}: auth.test failed (${err.slack_error ?? err.message}); skipping`);
    return null;
  }
}

const UPSERT_ACCESS = `
INSERT INTO channel_token_access (
  slack_channel_id, token_owner_name, token_owner_slack_id, is_member, refreshed_at
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT (slack_channel_id, token_owner_name) DO UPDATE SET
  token_owner_slack_id = excluded.token_owner_slack_id,
  is_member = excluded.is_member,
  refreshed_at = excluded.refreshed_at
`;

export async function buildRouter(db, { types = "public_channel,private_channel" } = {}) {
  const tokens = loadTokenEnvs();
  if (tokens.length === 0) {
    throw new Error("No SLACK_TOKEN_* env vars found. Set at least SLACK_TOKEN_MARK in .env.local.");
  }

  // Identify each token so we know whose membership we're about to record.
  const identified = [];
  for (const t of tokens) {
    const id = await identifyToken(t);
    if (id) identified.push(id);
  }
  if (identified.length === 0) {
    throw new Error("All Slack tokens failed auth.test. Check that they're valid xoxp- user tokens.");
  }
  console.log(`[router] active tokens: ${identified.map(t => `${t.name} (${t.slack_username})`).join(", ")}`);

  // For each token, list channels and persist membership.
  // A channel is reachable by any owner whose is_member=1; we route to the
  // first such owner (preference order: mark < jabbok < willy, just for
  // determinism — accessing through any of them works the same).
  const channelOwners = new Map(); // channel_id -> [ {name, token, slack_user_id}, ... ]
  const channelMeta = new Map();   // channel_id -> raw channel object (for upserting metadata)
  const ts = nowIso();
  const upsert = db.prepare(UPSERT_ACCESS);

  // Pass 1: enumerate every owner's channels into memory. We only persist
  // after we know all channel metadata, because channel_token_access has a
  // FK on channels.slack_channel_id and we need channels rows to exist first.
  const ownerSeenChannels = new Map(); // owner.name -> Map(channelId -> isMember)
  for (const owner of identified) {
    const seen = new Map();
    let memberCount = 0;
    try {
      for await (const ch of listChannels({ types, token: owner.token })) {
        const isMember = ch.is_member ? 1 : 0;
        seen.set(ch.id, isMember);
        if (isMember) memberCount += 1;
        channelMeta.set(ch.id, ch);
        if (isMember) {
          if (!channelOwners.has(ch.id)) channelOwners.set(ch.id, []);
          channelOwners.get(ch.id).push(owner);
        }
      }
    } catch (err) {
      console.error(`[router] ${owner.name}: listChannels failed: ${err.message}`);
    }
    ownerSeenChannels.set(owner.name, seen);
    console.log(`[router] ${owner.name}: ${memberCount}/${seen.size} channels with membership`);
  }

  // Pass 2: persist channel metadata first (parents), then access rows (children).
  let metaCount = 0;
  const txn = db.transaction(() => {
    for (const [, c] of channelMeta) {
      upsertChannel(db, {
        id: c.id, name: c.name,
        channel_type: c.is_private ? "private" : "public",
        is_archived: !!c.is_archived,
        ingestion_priority: "normal",
      });
      metaCount += 1;
    }
    // Now access rows can satisfy the FK.
    for (const owner of identified) {
      const seen = ownerSeenChannels.get(owner.name) ?? new Map();
      for (const [cid, isMember] of seen) {
        upsert.run(cid, owner.name, owner.slack_user_id, isMember, ts);
      }
    }
  });
  txn();
  console.log(`[router] persisted ${metaCount} channel metadata rows`);

  // Build the runtime routing map: pick deterministic first owner per channel.
  const route = new Map();
  for (const [cid, owners] of channelOwners) {
    // Preserve KNOWN_OWNERS order for determinism.
    owners.sort((a, b) => KNOWN_OWNERS.indexOf(a.name) - KNOWN_OWNERS.indexOf(b.name));
    route.set(cid, owners[0]);
  }

  return {
    tokenForChannel(channelId) {
      return route.get(channelId) ?? null;
    },
    allTokens() {
      return identified.map(t => [t.name, t.token]);
    },
    routeMap: route,
    identified,
    accessibleChannels() {
      return [...route.keys()];
    },
  };
}

// Fast router built from the cached channel_token_access table — skips
// channel enumeration entirely. Use this when caller doesn't need fresh
// membership data (e.g. digest revalidation runs every few hours; the
// cache is rebuilt on each ingest tick already).
//
// Returns the same shape as buildRouter() but only the methods that read
// from the cache: tokenForChannel, allTokens, identified, accessibleChannels.
export function buildRouterFromCache(db) {
  const tokens = loadTokenEnvs();
  if (tokens.length === 0) {
    throw new Error("No SLACK_TOKEN_* env vars found.");
  }
  // Map token name -> token string from env.
  const envByName = new Map(tokens.map(t => [t.name, t.token]));
  // Pull all access rows joined with token_owner_slack_id.
  const rows = db.prepare(`
    SELECT slack_channel_id, token_owner_name, token_owner_slack_id, is_member
    FROM channel_token_access
    WHERE is_member = 1
  `).all();
  // identified[] reflects token owners we've seen in the cache that we still
  // have env tokens for. Names we've seen but no env token = silently dropped.
  const identifiedMap = new Map();
  for (const r of rows) {
    if (!envByName.has(r.token_owner_name)) continue;
    if (!identifiedMap.has(r.token_owner_name)) {
      identifiedMap.set(r.token_owner_name, {
        name: r.token_owner_name,
        token: envByName.get(r.token_owner_name),
        slack_user_id: r.token_owner_slack_id,
      });
    }
  }
  const identified = [...identifiedMap.values()];
  if (identified.length === 0) {
    throw new Error("No usable token/channel access pairs in cache. Run buildRouter (full) once.");
  }
  // Build channel -> token routing in KNOWN_OWNERS preference order.
  const route = new Map();
  for (const r of rows) {
    if (!envByName.has(r.token_owner_name)) continue;
    const owner = identifiedMap.get(r.token_owner_name);
    const existing = route.get(r.slack_channel_id);
    if (!existing) { route.set(r.slack_channel_id, owner); continue; }
    if (KNOWN_OWNERS.indexOf(owner.name) < KNOWN_OWNERS.indexOf(existing.name)) {
      route.set(r.slack_channel_id, owner);
    }
  }
  return {
    tokenForChannel(channelId) { return route.get(channelId) ?? null; },
    allTokens() { return identified.map(t => [t.name, t.token]); },
    routeMap: route,
    identified,
    accessibleChannels() { return [...route.keys()]; },
    fromCache: true,
  };
}

// Helper: ensure channel_token_access has rows for a single channel by
// attempting a lightweight fetch with each token. Useful when a new
// channel shows up between full router rebuilds.
export async function refreshChannelAccess(db, channelId) {
  const tokens = loadTokenEnvs();
  const ts = nowIso();
  for (const t of tokens) {
    const id = await identifyToken(t);
    if (!id) continue;
    let isMember = 0;
    try {
      // conversations.info returns is_member for the authenticated user.
      const r = await fetchAuthTest({ token: id.token }); // sanity
      // Use a direct call below since slack-api doesn't expose conversations.info yet.
      const resp = await fetch(`https://slack.com/api/conversations.info?channel=${encodeURIComponent(channelId)}`, {
        headers: { Authorization: `Bearer ${id.token}`, Accept: "application/json" },
      });
      const j = await resp.json();
      if (j.ok && j.channel?.is_member) isMember = 1;
    } catch {}
    db.prepare(UPSERT_ACCESS).run(channelId, id.name, id.slack_user_id, isMember, ts);
  }
}
