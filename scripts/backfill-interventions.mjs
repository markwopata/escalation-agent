// Backfill intervention detection over every message already in the DB.
// Idempotent (UNIQUE index on the interventions table prevents dupes).
//
// Usage: npm run backfill:interventions

import { openDatabase } from "./lib/db.mjs";
import { loadWatchedExecs, detectInterventions, persistInterventions } from "./lib/intervention-detector.mjs";

const db = openDatabase();
const watched = loadWatchedExecs(db);
if (watched.size === 0) {
  console.error("No active watched_execs. Run `npm run seed:execs` first.");
  process.exit(1);
}
console.log(`Watching ${watched.size} exec(s):`, [...watched.values()].map(w => `${w.display_name} (${w.exec_role})`).join(", "));

const messages = db.prepare(`
  SELECT slack_channel_id, slack_ts, thread_ts, author_slack_user_id, text,
         mentions_user_ids_json, message_posted_at
  FROM messages
`).all();

let total = 0, withInterventions = 0, totalInterventions = 0;
for (const m of messages) {
  total += 1;
  const interventions = detectInterventions(m, watched);
  if (interventions.length) {
    const inserted = persistInterventions(db, interventions);
    if (inserted > 0) {
      withInterventions += 1;
      totalInterventions += inserted;
    }
  }
}
console.log(JSON.stringify({
  messages_scanned: total,
  messages_with_interventions: withInterventions,
  total_interventions_inserted: totalInterventions,
}, null, 2));

const breakdown = db.prepare(`
  SELECT exec_display_name, intervention_type, COUNT(*) AS n
  FROM ceo_interventions
  GROUP BY exec_display_name, intervention_type
  ORDER BY exec_display_name, intervention_type
`).all();
console.log("Breakdown by exec / type:", breakdown);
