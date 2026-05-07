// CLI wrapper for applying / rejecting a criterion_proposal.
//
// Usage:
//   node scripts/apply-proposal.mjs <id> --accept [--by <name>]
//   node scripts/apply-proposal.mjs <id> --reject [--by <name>]
//
// On accept: extracts structured fields from proposed_change via Haiku and
// writes to active_criteria / prompt_overrides / silence_rules. On reject:
// just marks the proposal status. Either way, status flips from 'pending'
// and the row stops showing up in the pending-proposals digest.

import process from "node:process";
import { openDatabase } from "./lib/db.mjs";
import { applyProposal } from "./lib/apply-proposal.mjs";
import { buildPromptVersion } from "./lib/triage-prompt.mjs";

function parseArgs(argv) {
  const args = { id: null, decision: null, by: "cli" };
  const rest = [];
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--accept") args.decision = "accept";
    else if (a === "--reject") args.decision = "reject";
    else if (a === "--by") args.by = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node scripts/apply-proposal.mjs <id> --accept|--reject [--by <name>]");
      process.exit(0);
    }
    else rest.push(a);
  }
  if (rest.length) args.id = Number(rest[0]);
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.id || !args.decision) {
    console.error("Usage: node scripts/apply-proposal.mjs <id> --accept|--reject [--by <name>]");
    process.exit(1);
  }
  const db = openDatabase();
  const versionBefore = buildPromptVersion(db);
  console.log(`Prompt version before: ${versionBefore}`);

  const result = await applyProposal(db, args.id, { decision: args.decision, decidedBy: args.by });
  console.log(JSON.stringify(result, null, 2));

  const versionAfter = buildPromptVersion(db);
  console.log(`Prompt version after:  ${versionAfter}${versionAfter === versionBefore ? " (unchanged)" : " (BUMPED)"}`);
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
}
