// Fetches Slack profiles (with emails) for every observed slack_user whose
// email is NULL and isn't a known bot, then runs the employee-link
// reconciliation. Idempotent — re-running only touches users still missing
// an email.
//
// Slack's users.info is tier-4 (100 req/min). We pace conservatively at ~10
// req/sec with backoff on 429.
//
// Usage:
//   npm run backfill:profiles
//   npm run backfill:profiles -- --limit 100   # cap for a quick check
//   npm run backfill:profiles -- --dry-run

import process from "node:process";
import { openDatabase, nowIso } from "./lib/db.mjs";
import { fetchUserProfile } from "./lib/slack-api.mjs";
import { upsertSlackUser, reconcileEmployeeLinks } from "./lib/slack-store.mjs";

function parseArgs(argv) {
  const args = { limit: null, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const args = parseArgs(process.argv);
  const db = openDatabase();

  let candidates = db.prepare(`
    SELECT slack_user_id FROM slack_users
    WHERE (email IS NULL OR email = '') AND is_bot = 0
    ORDER BY observed_at DESC
  `).all();
  if (args.limit) candidates = candidates.slice(0, args.limit);

  console.log(`Backfilling profiles for ${candidates.length} slack users.`);
  if (args.dryRun) {
    console.log("(dry run — no API calls)");
    return;
  }

  let ok = 0, errors = 0, withEmail = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    const { slack_user_id } = candidates[i];
    try {
      const profile = await fetchUserProfile(slack_user_id);
      if (profile) {
        upsertSlackUser(db, {
          slack_user_id: profile.id,
          username: profile.name,
          real_name: profile.real_name ?? profile.profile?.real_name,
          display_name: profile.profile?.display_name,
          email: profile.profile?.email,
          title: profile.profile?.title,
          timezone: profile.tz,
          is_bot: profile.is_bot,
          is_restricted: profile.is_restricted,
          is_deleted: profile.deleted,
          profile_fetched_at: nowIso(),
        });
        ok += 1;
        if (profile.profile?.email) withEmail += 1;
      }
    } catch (err) {
      errors += 1;
      if (errors <= 5) console.error(`  ${slack_user_id}: ${err.message}`);
    }
    // Pace ~10/sec; if we hit 429 the slack-api fetchWithRetry takes over.
    if (i % 50 === 49) {
      console.log(`  progress: ${i + 1}/${candidates.length} (ok=${ok} email=${withEmail} errors=${errors})`);
    }
    await sleep(100);
  }

  console.log(`\nDone. ok=${ok}, with-email=${withEmail}, errors=${errors}`);
  console.log(`\nReconciling employee links by email…`);
  const reconciled = reconcileEmployeeLinks(db);
  console.log(`Reconciled: resolved=${reconciled.resolved} of ${reconciled.candidates_examined} candidates examined.`);

  console.log("\nFinal counts:");
  console.log(db.prepare(`SELECT
    (SELECT COUNT(*) FROM slack_users WHERE email IS NOT NULL AND email != '') AS with_email,
    (SELECT COUNT(*) FROM slack_users WHERE (email IS NULL OR email = '')) AS without_email,
    (SELECT COUNT(*) FROM employee_slack_link WHERE slack_user_id IS NOT NULL) AS linked_to_employee
  `).get());
}

try { await main(); } catch (e) { console.error(e instanceof Error ? e.stack : String(e)); process.exit(1); }
