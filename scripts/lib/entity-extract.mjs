// Regex-based entity extraction at ingest. Pulls structured pointers out of
// raw Slack message text into the message_entities table. The point is to
// make "all messages mentioning account #106396" a SQL JOIN, not a text
// search — that's how we bridge un-threaded re-emergence by exact match.
//
// Regex-first because it's free and runs at ingest. LLM-based extraction
// is layered in only if/when regex misses too much. Common patterns in
// EquipmentShare messages:
//   - Asset / equipment IDs: "asset 644698", "Asset #126298", "unit 441358"
//   - Work orders: "WO-7388474", "WO 6865420", "wo-7400760"
//   - Account / customer numbers: "account # 106396", "Customer #120718"
//   - Serial numbers: "S/N: 3093878", "SN: SY013JBK26308", "VIN: 3AKJ..."
//   - Phone numbers (Slack-formatted: <tel:6053199028|605-319-9028>)
//   - Workflow terms: DNR, off-rent, T&C, T3OS, ERP, ESU
//
// Each extraction stores both the normalized value and the raw match for
// auditing. Idempotent re-runs replace prior extractions for a message.

const PATTERNS = [
  // Asset / equipment IDs
  { type: "asset_id", re: /\b(?:asset|equipment|unit)[\s#]*(\d{4,7})\b/gi, normalize: (v) => v },
  // Work orders
  { type: "work_order", re: /\bWO[\s#-]*(\d{4,8})\b/gi, normalize: (v) => v },
  // Account / customer numbers
  { type: "account_number", re: /\b(?:account|customer|cust)[\s#]*(\d{4,8})\b/gi, normalize: (v) => v },
  // Serial numbers (Slack short form: S/N or SN with alphanumeric)
  { type: "serial_number", re: /\b(?:S\/N|SN|VIN)[\s:]*([A-Z0-9-]{6,})\b/gi, normalize: (v) => v.toUpperCase() },
  // Slack-formatted phones: <tel:6053199028|605-319-9028>
  { type: "phone", re: /<tel:(\d{10,15})\|[^>]*>/g, normalize: (v) => v },
];

// Workflow / system / criterion terms — case-insensitive whole-word match.
const WORKFLOW_TERMS = [
  "T3OS", "T3", "ERP", "ESU", "DNR", "Looker", "Trackunit", "Front",
  "JD Link", "Samsara", "VisionLink", "Salesforce", "shortcut",
  "off-rent", "off rent", "re-rent", "re rent",
  "T&C", "PDI", "AEMP", "fault code", "warranty", "credit hold",
];

// Major customer slugs to detect by name (independent of channel naming).
const CUSTOMER_NAMES = [
  "Vantage", "Stargate", "Apex Hubbard", "Apex", "Meta", "Google",
  "P66", "Phillips 66", "Byhalia", "Sweeny", "Borger",
  "BZI", "Nexus", "Yates", "Loyd", "First String", "ATCO",
  "JE Dunn", "Emery Sapp", "ESS", "Capital Equipment", "Flintco", "Superior Construction",
  "Houston Heavy Machinery", "City Rent", "R2B2", "Dunn", "Petra Inc", "Loyal Plumbing",
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WORKFLOW_RE = new RegExp("\\b(" + WORKFLOW_TERMS.map(escapeRegExp).join("|") + ")\\b", "gi");
const CUSTOMER_RE = new RegExp("\\b(" + CUSTOMER_NAMES.map(escapeRegExp).join("|") + ")\\b", "g");

export function extractEntities(text) {
  const out = [];
  if (!text || typeof text !== "string") return out;
  const seen = new Set();
  function add(type, value, raw) {
    const key = `${type}:${value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ entity_type: type, entity_value: value, raw_match: raw });
  }
  for (const p of PATTERNS) {
    let m;
    p.re.lastIndex = 0;
    while ((m = p.re.exec(text)) !== null) {
      const value = p.normalize(m[1]);
      add(p.type, value, m[0]);
    }
  }
  // Workflow terms
  let wm;
  WORKFLOW_RE.lastIndex = 0;
  while ((wm = WORKFLOW_RE.exec(text)) !== null) {
    add("workflow_term", wm[1].toUpperCase(), wm[0]);
  }
  // Customer names
  let cm;
  CUSTOMER_RE.lastIndex = 0;
  while ((cm = CUSTOMER_RE.exec(text)) !== null) {
    add("customer_name", cm[1], cm[0]);
  }
  return out;
}

export function persistEntities(db, channelId, slackTs, entities) {
  // Idempotent: clear prior extractions for this message, then insert anew.
  db.prepare(`DELETE FROM message_entities WHERE slack_channel_id = ? AND slack_ts = ?`).run(channelId, slackTs);
  if (!entities || entities.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO message_entities (
      slack_channel_id, slack_ts, entity_type, entity_value, raw_match, extraction_method, extracted_at
    ) VALUES (?, ?, ?, ?, ?, 'regex', ?)
  `);
  const now = new Date().toISOString();
  const txn = db.transaction(() => {
    for (const e of entities) stmt.run(channelId, slackTs, e.entity_type, e.entity_value, e.raw_match ?? null, now);
  });
  txn();
  return entities.length;
}
