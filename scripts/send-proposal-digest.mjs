// DMs pending criterion_proposals (from Tier C reflection) to every
// watched_exec. Each proposal goes out as one DM; reactions on the parent
// message drive the apply/reject decision (see feedback-listener).
//
// Idempotent: never re-delivers a proposal already sent to the same exec
// (UNIQUE index on proposal_deliveries.exec_employee_id + proposal_id).
//
// Usage:
//   npm run send:proposals                  # all pending proposals to all watched execs
//   npm run send:proposals -- --dry-run     # log what we'd send
//   npm run send:proposals -- --recipient mark.wopata
//   npm run send:proposals -- --limit 3
//   npm run send:proposals -- --types new_criterion,silence_pattern

import process from "node:process";
import { openDatabase, nowIso } from "./lib/db.mjs";
import { openIm, postMessage, getWriteTokenKind } from "./lib/slack-write.mjs";

function parseArgs(argv) {
  const args = { dryRun: false, recipient: null, limit: null, types: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--recipient") args.recipient = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--types") args.types = argv[++i].split(",").map(s => s.trim());
  }
  return args;
}

const TYPE_EMOJI = {
  new_criterion: ":new:",
  edit_criterion: ":pencil2:",
  calibration_shift: ":balance_scale:",
  silence_pattern: ":mute:",
};

function loadPendingProposalsForRecipient(db, recipientSlackUserId, types) {
  const typeFilter = types && types.length ? `AND p.proposal_type IN (${types.map(() => "?").join(",")})` : "";
  const params = [recipientSlackUserId, ...(types ?? [])];
  return db.prepare(`
    SELECT p.id, p.proposal_type, p.proposed_change, p.rationale,
           p.evidence_json, p.created_at, p.reflection_run_id
    FROM criterion_proposals p
    LEFT JOIN proposal_deliveries d
      ON d.recipient_slack_user_id = ?
     AND d.proposal_id = p.id
    WHERE p.status = 'pending'
      AND d.id IS NULL
      ${typeFilter}
    ORDER BY p.id ASC
  `).all(...params);
}

function buildProposalBlocks(p) {
  const emoji = TYPE_EMOJI[p.proposal_type] ?? ":bulb:";
  const headline = `${emoji} *Proposal #${p.id}* · _${p.proposal_type}_`;

  const blocks = [];
  blocks.push({ type: "section", text: { type: "mrkdwn", text: `${headline}\n${p.proposed_change}` } });
  if (p.rationale) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `_Why:_ ${p.rationale.slice(0, 600)}${p.rationale.length > 600 ? "…" : ""}` }] });
  }
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `:white_check_mark: react to *accept and apply* · :x: react to *reject* · reply here to ask questions or modify` }],
  });
  return blocks;
}

function buildPlaintextFallback(p) {
  return `[proposal #${p.id} · ${p.proposal_type}] ${p.proposed_change.slice(0, 220)}`;
}

async function deliverToExec(db, exec, args) {
  const recipient = exec.slack_user_id;
  if (!recipient) {
    console.log(`Skipping ${exec.display_name}: no slack_user_id`);
    return { sent: 0 };
  }
  let proposals = loadPendingProposalsForRecipient(db, recipient, args.types);
  if (args.limit) proposals = proposals.slice(0, args.limit);
  if (proposals.length === 0) {
    console.log(`${exec.display_name}: no new proposals to deliver`);
    return { sent: 0 };
  }

  let imChannel = null;
  if (!args.dryRun) {
    imChannel = await openIm(recipient);
    if (!imChannel) {
      console.error(`${exec.display_name}: failed to open IM`);
      return { sent: 0 };
    }
  }

  let sent = 0;
  for (const p of proposals) {
    const blocks = buildProposalBlocks(p);
    const text = buildPlaintextFallback(p);
    if (args.dryRun) {
      console.log(`[DRY] → ${exec.display_name} : ${text}`);
      sent += 1;
      continue;
    }
    try {
      const result = await postMessage({ channel: imChannel, text, blocks });
      db.prepare(`
        INSERT OR IGNORE INTO proposal_deliveries (
          exec_employee_id, recipient_slack_user_id, proposal_id,
          bot_message_channel, bot_message_ts, delivered_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(exec.employee_id, recipient, p.id, result.channel, result.ts, nowIso());
      console.log(`✓ ${exec.display_name} ← proposal #${p.id} (${p.proposal_type})`);
      sent += 1;
    } catch (err) {
      console.error(`✗ ${exec.display_name} ← proposal #${p.id}: ${err.message}`);
    }
  }
  return { sent };
}

async function main() {
  const args = parseArgs(process.argv);
  const db = openDatabase();
  const tokenKind = getWriteTokenKind();
  console.log(`Write token: ${tokenKind}`);
  if (args.dryRun) console.log("(dry run — no Slack calls)");

  let execs = db.prepare(`SELECT * FROM watched_execs WHERE active = 1 AND slack_user_id IS NOT NULL`).all();
  if (args.recipient) execs = execs.filter(e => e.display_name.toLowerCase().includes(args.recipient.toLowerCase()));
  console.log(`Delivering proposals to ${execs.length} exec(s): ${execs.map(e => e.display_name).join(", ")}`);

  let total = 0;
  for (const exec of execs) {
    const { sent } = await deliverToExec(db, exec, args);
    total += sent;
  }
  console.log(`\nTotal: ${total} proposal message(s) sent.`);
}

try { await main(); } catch (e) { console.error(e instanceof Error ? e.stack : String(e)); process.exit(1); }
