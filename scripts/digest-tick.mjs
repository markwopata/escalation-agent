// Daily digest tick. Runs once per day to:
//   1. Re-run rollups so overnight investigations roll into escalations
//   2. Backfill display titles on any new escalations (Haiku)
//   3. Deliver per-recipient digests to all active watched_execs
//
// IMPORTANT: this script does NOT use --ignore-deliveries. Dedupe via
// digest_deliveries is the entire point of the daily schedule — each exec
// sees ONLY items they haven't seen before. The sev-floor and source-min
// backfills naturally pick up older items on quiet days.
//
// Idempotent: re-running mid-day after a failed run will pick up where it
// left off — already-delivered escalations stay deduped.
//
// Usage:
//   node scripts/digest-tick.mjs                    # default (24h fresh window, max 6, all active execs)
//   node scripts/digest-tick.mjs --skip-rollup      # if rollups already ran this hour
//   node scripts/digest-tick.mjs --skip-backfill    # skip the Haiku title backfill (faster, but may show "Escalation #N")

import process from "node:process";
import { spawn } from "node:child_process";

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`)));
    child.on("error", reject);
  });
}

function parseArgs(argv) {
  const args = { skipRollup: false, skipBackfill: false, sinceHours: 24, max: 6 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--skip-rollup") args.skipRollup = true;
    else if (a === "--skip-backfill") args.skipBackfill = true;
    else if (a === "--since-hours") args.sinceHours = Number(argv[++i]);
    else if (a === "--max") args.max = Number(argv[++i]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const ts = () => new Date().toISOString();
  console.log(`[${ts()}] Digest tick starting...`);

  if (!args.skipRollup) {
    console.log(`[${ts()}] Step 1/3: Slack rollup`);
    await run("node", ["scripts/roll-up-escalations.mjs"]);
    console.log(`[${ts()}] Step 1/3: Front rollup`);
    await run("node", ["scripts/roll-up-front-escalations.mjs"]);
  } else {
    console.log(`[${ts()}] Step 1/3: skipped (--skip-rollup)`);
  }

  if (!args.skipBackfill) {
    console.log(`[${ts()}] Step 2/3: Title backfill (Haiku)`);
    await run("node", ["scripts/backfill-escalation-titles.mjs"]);
  } else {
    console.log(`[${ts()}] Step 2/3: skipped (--skip-backfill)`);
  }

  console.log(`[${ts()}] Step 3/3: Sending digests to all active recipients`);
  // No --ignore-deliveries — the whole point of the daily schedule is that
  // each exec sees only items they haven't been delivered before.
  await run("node", [
    "scripts/send-digest.mjs",
    "--since-hours", String(args.sinceHours),
    "--max", String(args.max),
  ]);

  console.log(`[${ts()}] Digest tick complete.`);
}

try { await main(); } catch (e) {
  console.error(`[${new Date().toISOString()}] Digest tick failed: ${e.message}`);
  process.exit(1);
}
