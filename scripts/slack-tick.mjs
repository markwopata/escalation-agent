// Hourly Slack tick. Mirror of front-tick.mjs.
//
// Each tick:
//   1. Re-runs the multi-token router (refreshes channel_token_access + new channel metadata).
//   2. Pulls last 2 hours of messages from accessible channels.
//   3. Submits Tier A batch for any newly ingested messages (with $20 cap).
//   4. Polls any in-flight Slack batches and persists ended ones.
//
// All operations are no-ops when there's nothing new. Typical wall time
// per tick: 5-15 minutes (mostly Slack rate limits during the per-channel
// pulls — 1,200+ channels × tier-4 limits).

import process from "node:process";
import { spawn } from "node:child_process";

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`)));
    child.on("error", reject);
  });
}

async function main() {
  const ts = () => new Date().toISOString();
  console.log(`[${ts()}] Slack tick starting...`);
  try {
    await run("node", ["scripts/ingest-slack-24h.mjs", "--hours", "2"]);
    await run("node", ["scripts/triage-batch.mjs", "submit", "--cap", "20"]);
    await run("node", ["scripts/triage-batch.mjs", "poll"]);
    // Tier B: investigate up to 20 flagged-but-uninvestigated items per
    // tick. Without this the digest pool starves — triage flags accumulate
    // but never get promoted to investigations, so no Slack escalations land
    // in the digest. Cap of 20/hr keeps cost bounded (~$1/hr at Sonnet
    // rates) while clearing the typical 30-40/day flag rate over a few hours.
    await run("node", ["scripts/investigate-flagged.mjs", "--limit", "20"]);
    console.log(`[${ts()}] Slack tick complete.`);
  } catch (err) {
    console.error(`[${ts()}] Tick failed: ${err.message}`);
    process.exit(1);
  }
}

await main();
