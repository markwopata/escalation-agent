// Records a piece of exec feedback. Free-text body is the load-bearing field;
// everything else is metadata that helps Tier C downstream.
//
// Usage:
//   echo "the panel slip thing was useful but I want fewer routine fleet allocations" \
//     | npm run feedback -- --exec mark.wopata --target-type general --sentiment praise
//
//   echo "this was wrong — there's no actual customer impact yet" \
//     | npm run feedback -- --exec mark.wopata --target-type escalation --target-id 7 --sentiment not_useful
//
//   echo "going forward please flag anything mentioning Vantage or Stargate immediately" \
//     | npm run feedback -- --exec mark.wopata --target-type general --sentiment other
//
// Or pass --text inline:
//   npm run feedback -- --exec mark --target-type general --text "I want more telematics signal"

import process from "node:process";
import { readFileSync } from "node:fs";
import { openDatabase, nowIso } from "./lib/db.mjs";

function parseArgs(argv) {
  const args = {
    exec: null,
    target_type: "general",
    target_id: null,
    sentiment: null,
    tags: null,
    text: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--exec") args.exec = argv[++i];
    else if (a === "--target-type") args.target_type = argv[++i];
    else if (a === "--target-id") args.target_id = Number(argv[++i]);
    else if (a === "--sentiment") args.sentiment = argv[++i];
    else if (a === "--tags") args.tags = argv[++i].split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--text") args.text = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node scripts/record-exec-feedback.mjs --exec <name> [--target-type general|escalation|criterion_proposal] [--target-id N] [--sentiment ...] [--tags a,b,c] [--text \"...\"]");
      console.log("If --text is omitted, body is read from stdin.");
      process.exit(0);
    } else { console.error(`Unknown arg: ${a}`); process.exit(1); }
  }
  return args;
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) { resolve(""); return; }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; });
    process.stdin.on("end", () => resolve(data));
  });
}

const VALID_TARGET_TYPES = new Set(["escalation", "criterion_proposal", "general"]);
const VALID_SENTIMENTS = new Set(["useful", "not_useful", "noise", "wrong_severity", "praise", "other", null, undefined]);

async function main() {
  const args = parseArgs(process.argv);

  if (!VALID_TARGET_TYPES.has(args.target_type)) {
    console.error(`--target-type must be one of: ${[...VALID_TARGET_TYPES].join(", ")}`);
    process.exit(1);
  }
  if (!VALID_SENTIMENTS.has(args.sentiment)) {
    console.error(`--sentiment must be one of: useful, not_useful, noise, wrong_severity, praise, other`);
    process.exit(1);
  }

  let body = args.text;
  if (!body) body = await readStdin();
  body = (body ?? "").trim();
  if (!body) {
    console.error("No feedback text provided (use --text or pipe via stdin).");
    process.exit(1);
  }

  const db = openDatabase();

  // Validate target_id if a target_type that requires one
  if (args.target_type === "escalation" && args.target_id) {
    const exists = db.prepare("SELECT id FROM escalations WHERE id = ?").get(args.target_id);
    if (!exists) {
      console.error(`No escalation with id=${args.target_id} found.`);
      process.exit(1);
    }
  }

  const result = db.prepare(`
    INSERT INTO exec_feedback (
      exec_name, target_type, target_id, feedback_text, sentiment, tags_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    args.exec ?? null,
    args.target_type,
    args.target_id ?? null,
    body,
    args.sentiment ?? null,
    args.tags ? JSON.stringify(args.tags) : null,
    nowIso(),
  );

  // Side effect: if this is feedback on an escalation with sentiment, also
  // bump that escalation's exec_action.
  if (args.target_type === "escalation" && args.target_id && args.sentiment) {
    let action = "acknowledged";
    if (args.sentiment === "not_useful" || args.sentiment === "noise") action = "dismissed";
    else if (args.sentiment === "useful" || args.sentiment === "praise") action = "acknowledged";
    db.prepare(`
      UPDATE escalations SET exec_action = ?, exec_action_at = ?, exec_notes = ?
      WHERE id = ?
    `).run(action, nowIso(), body.slice(0, 500), args.target_id);
  }

  console.log(JSON.stringify({
    feedback_id: result.lastInsertRowid,
    target_type: args.target_type,
    target_id: args.target_id ?? null,
    body_preview: body.slice(0, 80) + (body.length > 80 ? "…" : ""),
  }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
