// Override the role labels in FRONT_ESCALATION_THREAD_FLAT.
//
// Andrew's pipeline assigns role='es_employee' only when Front carries a
// teammate AUTHOR_ID. When an ES employee writes IN to a Front inbox via
// email (instead of replying from inside Front), the AUTHOR_ID is null
// and the row is labeled role='customer'. That breaks our reply-detection
// heuristics — internal-to-internal threads look like customer-to-customer.
//
// Workaround: inspect the SENDER'S own portion of the message — i.e., the
// part before any "Forwarded message" / "On X wrote:" / quoted-`>` block.
// If the sender's own block contains an @equipmentshare.com email
// (typically in their signature), they're an ES employee. If not, the
// only @equipmentshare.com refs are inside quoted forwards, which don't
// indicate the sender's identity.

const ES_EMAIL_RE = /\b[A-Z0-9._%+-]+@equipmentshare\.com\b/i;

// Markers that indicate a forwarded/quoted block follows.
const FORWARD_MARKERS = [
  /-{2,}\s*Forwarded message\s*-{2,}/i,
  /-{2,}\s*Original Message\s*-{2,}/i,
  /^From:\s.+\nSent:\s/im,
  /^On\s+[A-Z][a-z]+,?\s+[A-Z][a-z]+\s+\d+,?\s+\d{4}/m, // "On Mon, Apr 21, 2026..."
  /^On\s+[A-Z][a-z]+\s+\d+,?\s+\d{4}\s+at\s+\d+:\d+/m, // "On April 21, 2026 at 8:51 AM"
  /^>+\s/m, // quoted-line prefix
];

// Strip the message down to the sender's own contribution.
function senderBlock(text) {
  if (!text) return "";
  let cutAt = text.length;
  for (const re of FORWARD_MARKERS) {
    const m = re.exec(text);
    if (m && m.index < cutAt) cutAt = m.index;
  }
  return text.slice(0, cutAt);
}

export function fixedRole(turn) {
  if (turn.ROLE === "es_employee") return "es_employee"; // already correct upstream
  if (turn.AUTHOR_ID) return "es_employee"; // teammate ID present, trust Front
  if (!turn.TEXT) return "customer";
  const own = senderBlock(turn.TEXT);
  if (ES_EMAIL_RE.test(own)) return "es_employee";
  return "customer";
}

export function applyRoleFix(turns) {
  return turns.map(t => ({ ...t, ROLE: fixedRole(t) }));
}
