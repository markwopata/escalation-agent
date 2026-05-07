// Backfill `display_emoji` on escalations. Haiku picks a single emoji that
// reflects the *kind* of issue (not severity) so the digest header tells
// the exec at a glance what kind of problem they're looking at:
//   💰 financial / earnings impact      🚛 logistics / fleet
//   ⚖️ legal / compliance               💻 IT / system / outage
//   📡 connectivity / network           🦺 safety
//   🤝 customer relationship            🛑 process obstruction
//   🔥 urgent / on-fire situation       👻 silence / dead air
// (Haiku picks freely; the list above is just illustrative — no whitelist.)

import process from "node:process";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { openDatabase, nowIso } from "./lib/db.mjs";
import { loadLocalEnv } from "./lib/load-env.mjs";

loadLocalEnv();

const MODEL = "claude-haiku-4-5";

const Schema = z.object({
  emoji: z.string().min(1).max(8)
    .describe("A single emoji character that best captures the *kind* of issue (financial, IT, customer, legal, safety, process, etc.). Not severity — every escalation is a problem. Just one emoji."),
  rationale: z.string().min(3).max(120)
    .describe("Two-to-six word reason for this emoji choice."),
});

const SYSTEM = `You pick a single emoji that captures the kind of issue an escalation is about. Severity is not the point — every escalation is already a problem. Pick something contextual:
- 💰 / 📉 / 💸 — financial impact, earnings, deals
- ⚖️ / 📜 — legal, contracts, compliance
- 💻 / ⚙️ / 🔌 — IT, systems, software
- 📡 / 🛰️ / 🌐 — connectivity, internet, networking
- 🚛 / 🛻 / 🏗️ — fleet, equipment, jobsite
- 🦺 / 🚨 — safety incident
- 🤝 / 📞 — customer relationship / call needed
- 🛑 / 🧱 — process blocker, obstruction
- 👻 / 🔇 — dead air, no response
- 🔥 — urgent, on-fire situation
- 🆕 — new location / new branch
- 💳 — billing / payment / invoicing
- 🩺 — health / triage of a system
- ⏱️ — deadline, time-sensitive
Pick the one that most directly indicates what the issue is *about*. Don't combine emojis. Just one.`;

let cachedClient = null;
function getClient() {
  if (!cachedClient) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    cachedClient = new Anthropic();
  }
  return cachedClient;
}

function parseArgs(argv) {
  const args = { limit: null, force: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--force") args.force = true;
  }
  return args;
}

async function pickEmoji(esc) {
  const client = getClient();
  const userContent = [
    `Title: ${esc.display_title ?? "(no title)"}`,
    `Criterion: ${esc.primary_criterion}`,
    `Source: ${esc.source ?? "slack"}`,
    `Channel/Inbox: ${esc.channel_name ?? esc.front_inbox_name ?? "?"}`,
    "",
    `Short summary: ${esc.display_title_short_summary ?? "(none)"}`,
    "",
    `Full summary: ${(esc.representative_exec_summary ?? "").slice(0, 1500)}`,
    "",
    "Pick one emoji that captures the kind of issue.",
  ].join("\n");
  const r = await client.messages.parse({
    model: MODEL,
    max_tokens: 200,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userContent }],
    output_config: { format: zodOutputFormat(Schema) },
  });
  return r.parsed_output;
}

async function main() {
  const args = parseArgs(process.argv);
  const db = openDatabase();
  const filter = args.force ? "" : "AND display_emoji IS NULL";
  const rows = db.prepare(`
    SELECT e.id, e.primary_criterion, e.source, e.display_title,
           e.display_title_short_summary, e.representative_exec_summary,
           c.name AS channel_name, fc.inbox_name AS front_inbox_name
    FROM escalations e
    LEFT JOIN channels c ON c.slack_channel_id = e.slack_channel_id
    LEFT JOIN front_conversations fc ON fc.conversation_id = e.front_conversation_id
    WHERE e.exec_action = 'pending' ${filter}
    ORDER BY e.id
    ${args.limit ? `LIMIT ${Number(args.limit)}` : ""}
  `).all();
  console.log(`Picking emojis for ${rows.length} escalation${rows.length === 1 ? "" : "s"}.`);
  const upsert = db.prepare("UPDATE escalations SET display_emoji = ? WHERE id = ?");
  let ok = 0, errors = 0;
  for (const e of rows) {
    try {
      const out = await pickEmoji(e);
      upsert.run(out.emoji, e.id);
      console.log(`  #${e.id} ${out.emoji} — ${out.rationale}`);
      ok += 1;
    } catch (err) {
      console.error(`  #${e.id} error: ${err.message}`);
      errors += 1;
    }
  }
  console.log(`\nDone. ${ok} ok, ${errors} errors.`);
}

await main();
