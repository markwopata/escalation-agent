// Seeds the watched_execs table with the leadership + audience-owner
// recipients of the daily digest. Idempotent; safe to re-run.
//
// EDIT THE SEED LIST BELOW BEFORE RUNNING. The example values are placeholders;
// replace with your org's real Slack user IDs and names.
//
// To find a Slack user ID: open the user's profile in Slack → ⋮ → Copy member
// ID (format starts with `U`). Or query the slack_users table populated by
// scripts/backfill-slack-profiles.mjs after some Slack ingestion has run.
//
// Usage: npm run seed:execs

import { openDatabase, nowIso } from "./lib/db.mjs";

const SEED = [
  {
    employee_id: "EXAMPLE-CEO",
    slack_user_id: "U00000001",
    display_name: "Example CEO",
    exec_role: "CEO",
    notes: "Founder/CEO. Direct interventions in any Slack channel are treated as top-priority ground-truth signals during Tier B investigation.",
  },
  {
    employee_id: "EXAMPLE-PRES",
    slack_user_id: "U00000002",
    display_name: "Example President",
    exec_role: "President",
    notes: "Founder/President. Audience for the daily digest.",
  },
  {
    employee_id: null,                  // resolved below from email if available
    slack_user_id: "U00000003",
    display_name: "Example Audience-Owner",
    exec_role: "Audience-Owner",
    notes: "Project owner. Receives the digest and provides feedback that the agent treats as ground-truth calibration.",
  },
];

const db = openDatabase();
const now = nowIso();
const stmt = db.prepare(`
  INSERT INTO watched_execs (
    employee_id, slack_user_id, display_name, exec_role, active, added_at, notes
  ) VALUES (?, ?, ?, ?, 1, ?, ?)
  ON CONFLICT(employee_id) DO UPDATE SET
    slack_user_id = COALESCE(excluded.slack_user_id, watched_execs.slack_user_id),
    display_name = excluded.display_name,
    exec_role = excluded.exec_role,
    active = 1,
    notes = COALESCE(excluded.notes, watched_execs.notes)
`);
for (const e of SEED) {
  // Resolve missing employee_id by Slack profile email lookup if possible.
  let employeeId = e.employee_id;
  if (!employeeId && e.slack_user_id) {
    const link = db.prepare(`
      SELECT e.employee_id
      FROM employees e
      JOIN slack_users s ON LOWER(s.email) = LOWER(e.employee_email)
      WHERE s.slack_user_id = ?
    `).get(e.slack_user_id);
    if (link?.employee_id) employeeId = link.employee_id;
    else employeeId = `slack-${e.slack_user_id}`;  // synthetic fallback so PK isn't null
  }
  stmt.run(employeeId, e.slack_user_id ?? null, e.display_name, e.exec_role, now, e.notes ?? null);
}
console.log(JSON.stringify(db.prepare("SELECT * FROM watched_execs").all(), null, 2));
