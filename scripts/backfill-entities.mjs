// Run regex entity extraction over every message already in the DB.
// Idempotent — replaces prior extractions per message.
//
// Usage: npm run backfill:entities

import { openDatabase } from "./lib/db.mjs";
import { extractEntities, persistEntities } from "./lib/entity-extract.mjs";

const db = openDatabase();
const messages = db.prepare("SELECT slack_channel_id, slack_ts, text FROM messages").all();
let total = 0, withEntities = 0, totalEntities = 0;
for (const m of messages) {
  total += 1;
  const ents = extractEntities(m.text ?? "");
  if (ents.length) {
    persistEntities(db, m.slack_channel_id, m.slack_ts, ents);
    withEntities += 1;
    totalEntities += ents.length;
  }
}
console.log(JSON.stringify({
  messages_scanned: total,
  messages_with_entities: withEntities,
  total_entities_extracted: totalEntities,
}, null, 2));

const counts = db.prepare(`
  SELECT entity_type, COUNT(*) AS n
  FROM message_entities
  GROUP BY entity_type
  ORDER BY n DESC
`).all();
console.log("By entity type:", counts);
