// Parses Slack message permalinks out of free-text DMs and resolves them
// to (channel_id, slack_ts). Handles:
//   - https://workspace.slack.com/archives/C123/p1777058139506929
//   - https://workspace.enterprise.slack.com/archives/C123/p1777058139506929
//   - Slack-wrapped form: <https://...|preview text>
//   - Thread links with ?thread_ts=...&cid=... (the cid query is sometimes
//     the canonical channel rather than the path segment)

const URL_RE = /<?(https?:\/\/[\w.-]+\.slack\.com\/archives\/([A-Z][A-Z0-9]+)\/p(\d+))(\?[^\s>|]*)?(?:\|[^>]*)?>?/g;

// Convert a Slack permalink ts (digits, dot stripped) back to the message ts
// format: "1777058139506929" → "1777058139.506929"
function unstripTs(packed) {
  if (packed.length < 7) return packed;
  return packed.slice(0, packed.length - 6) + "." + packed.slice(-6);
}

// Returns an array of { url, channel_id, slack_ts, thread_ts? } for every
// Slack message link found in `text`.
export function parseSlackMessageLinks(text) {
  if (!text || typeof text !== "string") return [];
  const out = [];
  const seen = new Set();
  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    const url = m[1];
    const pathChannel = m[2];
    const slackTs = unstripTs(m[3]);
    const queryString = m[4] ?? "";

    // The "cid" query parameter sometimes overrides the path channel for
    // enterprise-grid threaded messages. Prefer it when present.
    let channelId = pathChannel;
    let threadTs = null;
    if (queryString) {
      const params = new URLSearchParams(queryString.slice(1));
      const cid = params.get("cid");
      if (cid && /^[A-Z][A-Z0-9]+$/.test(cid)) channelId = cid;
      const tts = params.get("thread_ts");
      if (tts) threadTs = tts;
    }

    const key = `${channelId}:${slackTs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, channel_id: channelId, slack_ts: slackTs, thread_ts: threadTs });
  }
  return out;
}
