// Generates display_title + display_title_short_summary for every
// escalation that doesn't have one yet. Idempotent — re-running only
// touches escalations still missing a title.
//
// Cost: ~$0.0003 per escalation. 13 escalations = ~$0.004.
//
// Usage: npm run backfill:titles

import { openDatabase } from "./lib/db.mjs";
import { generateTitle } from "./lib/escalation-title.mjs";

const db = openDatabase();
const rows = db.prepare(`
  SELECT e.id, e.primary_criterion, e.representative_exec_summary,
         c.name AS channel_name,
         v.full_name AS author_full_name
  FROM escalations e
  LEFT JOIN channels c ON c.slack_channel_id = e.slack_channel_id
  LEFT JOIN v_employees_with_slack v ON v.slack_user_id = e.author_slack_user_id
  WHERE e.display_title IS NULL OR e.display_title = ''
`).all();

console.log(`Generating titles for ${rows.length} escalation(s)…`);
let ok = 0, errors = 0;
for (const r of rows) {
  try {
    const { title, short_summary } = await generateTitle({
      escId: r.id,
      criterion: r.primary_criterion,
      exec_summary: r.representative_exec_summary,
      channel_name: r.channel_name,
      author_full_name: r.author_full_name,
    });
    db.prepare(`UPDATE escalations SET display_title = ?, display_title_short_summary = ? WHERE id = ?`)
      .run(title, short_summary, r.id);
    console.log(`  #${r.id}: ${title}`);
    ok += 1;
  } catch (err) {
    console.error(`  #${r.id} failed: ${err.message}`);
    errors += 1;
  }
}
console.log(`\nDone. ${ok} ok, ${errors} errors.`);
