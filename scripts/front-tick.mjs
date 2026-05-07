// Hourly Front tick. Runs as a launchd-scheduled job to keep Front data
// flowing into the local DB and triaged.
//
// Each tick:
//   1. Pulls the last 2 hours of Front conversations from Snowflake
//      (overlap protects against partial-hour edge cases; idempotent upserts).
//   2. Submits Tier A batch for any newly ingested conversations.
//   3. Polls any in-flight batches and persists ended ones.
//
// All operations are no-ops when there's nothing to do, so running this
// hourly is cheap. Total wall-time per tick: usually 30-90 seconds.

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
  console.log(`[${ts()}] Front tick starting...`);
  try {
    // Step 1: ingest last 2h (overlap with prior hour catches edge cases).
    await run("node", ["scripts/ingest-front.mjs", "--hours", "2"]);
    // Step 2: submit Tier A on anything newly ingested.
    await run("node", ["scripts/triage-front-batch.mjs", "submit", "--cap", "20"]);
    // Step 3: poll any in-flight batches (this picks up the previous tick's submissions).
    await run("node", ["scripts/triage-front-batch.mjs", "poll"]);
    console.log(`[${ts()}] Front tick complete.`);
  } catch (err) {
    console.error(`[${ts()}] Tick failed: ${err.message}`);
    process.exit(1);
  }
}

await main();
