// Socket Mode listener that turns Slack reactions and DM replies into
// exec_feedback rows. Long-running daemon — run as systemd / launchd /
// pm2 service, or just `npm run listen:feedback` in a tmux pane while
// you iterate.
//
// Required env (in .env.local):
//   SLACK_APP_TOKEN     xapp-... (app-level token with connections:write)
//   SLACK_BOT_TOKEN_BOT xoxb-... (bot token, for API calls back to Slack)
//
// Maps:
//   Reaction emoji → sentiment:
//     :+1: / :thumbsup:                   → useful
//     :-1: / :thumbsdown:                 → not_useful
//     :no_entry: / :no_entry_sign: / :x:  → noise
//     :rotating_light:                    → wrong_severity
//     :white_check_mark: / :heavy_check_mark: / :ballot_box_with_check: → acknowledged
//     :fire: / :tada: / :raised_hands:    → praise
//     anything else                       → other
//
//   Reply types:
//     Reply in thread under a digest message → feedback on that escalation
//     Direct DM to the bot (no thread)       → general feedback
//
// Only feedback from watched_execs is treated as authoritative. Feedback
// from others is recorded but tagged so it doesn't drive Tier C.

import { SocketModeClient } from "@slack/socket-mode";
import { openDatabase, nowIso } from "./lib/db.mjs";
import { loadLocalEnv } from "./lib/load-env.mjs";
import { parseSlackMessageLinks } from "./lib/slack-link-parse.mjs";
import { fetchSingleMessage, fetchUserProfile } from "./lib/slack-api.mjs";
import { upsertChannel, upsertMessage, upsertSlackUser } from "./lib/slack-store.mjs";
import { postMessage } from "./lib/slack-write.mjs";
import { applyProposal } from "./lib/apply-proposal.mjs";
import { buildPromptVersion } from "./lib/triage-prompt.mjs";

loadLocalEnv();

const REACTION_TO_SENTIMENT = {
  "+1": "useful",
  "thumbsup": "useful",
  "-1": "not_useful",
  "thumbsdown": "not_useful",
  "no_entry": "noise",
  "no_entry_sign": "noise",
  "x": "noise",
  "rotating_light": "wrong_severity",
  "siren": "wrong_severity",
  "white_check_mark": "acknowledged",
  "heavy_check_mark": "acknowledged",
  "ballot_box_with_check": "acknowledged",
  "eyes": "acknowledged",
  "fire": "praise",
  "tada": "praise",
  "raised_hands": "praise",
};

function getEnv() {
  const appToken = process.env.SLACK_APP_TOKEN;
  const botToken = process.env.SLACK_BOT_TOKEN_BOT;
  if (!appToken) throw new Error("SLACK_APP_TOKEN is not set in .env.local (need xapp-... for Socket Mode).");
  if (!botToken) throw new Error("SLACK_BOT_TOKEN_BOT is not set in .env.local (need xoxb-... bot token).");
  return { appToken, botToken };
}

function lookupExecBySlackUserId(db, slackUserId) {
  return db.prepare(`SELECT * FROM watched_execs WHERE slack_user_id = ? AND active = 1`).get(slackUserId);
}

function lookupDeliveryByMessage(db, channel, ts) {
  return db.prepare(`SELECT * FROM digest_deliveries WHERE bot_message_channel = ? AND bot_message_ts = ?`).get(channel, ts);
}

function lookupProposalDeliveryByMessage(db, channel, ts) {
  return db.prepare(`SELECT * FROM proposal_deliveries WHERE bot_message_channel = ? AND bot_message_ts = ?`).get(channel, ts);
}

const ACCEPT_REACTIONS = new Set(["white_check_mark", "heavy_check_mark", "ballot_box_with_check", "+1", "thumbsup"]);
const REJECT_REACTIONS = new Set(["x", "no_entry", "no_entry_sign", "-1", "thumbsdown"]);

function recordFeedback(db, { execName, targetType, targetId, targetSlackChannelId, targetSlackTs, body, sentiment, sourceTag }) {
  const result = db.prepare(`
    INSERT INTO exec_feedback (
      exec_name, target_type, target_id,
      target_slack_channel_id, target_slack_ts,
      feedback_text, sentiment, tags_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    execName ?? null,
    targetType,
    targetId ?? null,
    targetSlackChannelId ?? null,
    targetSlackTs ?? null,
    body,
    sentiment ?? null,
    sourceTag ? JSON.stringify([sourceTag]) : null,
    nowIso(),
  );
  // Auto-bump escalation.exec_action mirroring record-exec-feedback.mjs
  if (targetType === "escalation" && targetId && sentiment) {
    let action = "acknowledged";
    if (sentiment === "not_useful" || sentiment === "noise") action = "dismissed";
    else if (sentiment === "useful" || sentiment === "praise" || sentiment === "acknowledged") action = "acknowledged";
    db.prepare(`UPDATE escalations SET exec_action = ?, exec_action_at = ?, exec_notes = ? WHERE id = ?`)
      .run(action, nowIso(), body.slice(0, 500), targetId);
  }
  return result.lastInsertRowid;
}

// Fetch a Slack message into the local DB if it's not already there.
// Returns the message row from our DB (post-upsert) or null if we couldn't
// access it.
async function ensureMessageIngested(db, channelId, slackTs) {
  const existing = db.prepare(
    `SELECT * FROM messages WHERE slack_channel_id = ? AND slack_ts = ?`
  ).get(channelId, slackTs);
  if (existing) return existing;

  // Make sure the channel is at least in our channels table so the FK works.
  const channel = db.prepare(`SELECT slack_channel_id FROM channels WHERE slack_channel_id = ?`).get(channelId);
  if (!channel) {
    upsertChannel(db, {
      id: channelId, name: channelId, channel_type: "unknown",
      is_archived: false, ingestion_priority: "normal",
    });
  }

  let raw = null;
  try {
    raw = await fetchSingleMessage(channelId, slackTs);
  } catch (err) {
    console.warn(`  fetchSingleMessage(${channelId}, ${slackTs}) failed: ${err.message}`);
    return null;
  }
  if (!raw) return null;

  // Lazy author profile if we don't have it.
  if (raw.user) {
    const have = db.prepare(`SELECT email FROM slack_users WHERE slack_user_id = ?`).get(raw.user);
    if (!have?.email) {
      try {
        const profile = await fetchUserProfile(raw.user);
        if (profile) {
          upsertSlackUser(db, {
            slack_user_id: profile.id, username: profile.name,
            real_name: profile.real_name ?? profile.profile?.real_name,
            display_name: profile.profile?.display_name, email: profile.profile?.email,
            title: profile.profile?.title, timezone: profile.tz,
            is_bot: profile.is_bot, is_restricted: profile.is_restricted, is_deleted: profile.deleted,
            profile_fetched_at: nowIso(),
          });
        }
      } catch (err) { /* ignore — profile fetch is best-effort */ }
    }
  }

  upsertMessage(db, channelId, raw);
  return db.prepare(
    `SELECT * FROM messages WHERE slack_channel_id = ? AND slack_ts = ?`
  ).get(channelId, slackTs);
}

// Build a short bot-ack message describing what we captured.
function describeExemplar({ message, channelName, authorName, currentTriage }) {
  const lines = [];
  const when = message?.message_posted_at?.slice(0, 10) ?? "?";
  const who = authorName ?? message?.author_username ?? "unknown";
  lines.push(`:bookmark: Captured #${channelName ?? message?.slack_channel_id} message from ${when} by ${who} as a positive exemplar.`);
  if (currentTriage) {
    if (currentTriage.worth_deeper_look) {
      lines.push(`Triage v${currentTriage.prompt_version_short}: flagged at *sev ${currentTriage.severity}* (${currentTriage.primary_criterion}).`);
    } else {
      lines.push(`Triage v${currentTriage.prompt_version_short}: *did NOT flag this* (sev 1, none) — Tier C will treat this as a labeled false-negative.`);
    }
  } else {
    lines.push(`No triage yet for this message — Tier A will pick it up on the next run.`);
  }
  lines.push(`Tier C reflection will fold this into the next criterion-proposal pass.`);
  return lines.join("\n");
}

async function handleExemplar(db, { senderExec, sender, dmChannel, dmTs, dmText, link }) {
  const { channel_id, slack_ts } = link;
  const message = await ensureMessageIngested(db, channel_id, slack_ts);
  if (!message) {
    await postMessage({
      channel: dmChannel,
      text: `:warning: Couldn't fetch that message (channel ${channel_id} / ts ${slack_ts}). Make sure the bot is in the channel or send a message I can read.`,
      threadTs: dmTs,
    });
    return null;
  }

  // Look up channel + author for the ack
  const channelRow = db.prepare(`SELECT name FROM channels WHERE slack_channel_id = ?`).get(channel_id);
  const authorRow = message.author_slack_user_id
    ? db.prepare(`SELECT full_name FROM v_employees_with_slack WHERE slack_user_id = ?`).get(message.author_slack_user_id)
    : null;

  // Most recent triage_run for this message, in any prompt version
  const triageRow = db.prepare(`
    SELECT prompt_version, worth_deeper_look, severity, primary_criterion
    FROM triage_runs
    WHERE slack_channel_id = ? AND slack_ts = ?
    ORDER BY ran_at DESC LIMIT 1
  `).get(channel_id, slack_ts);
  const currentTriage = triageRow ? { ...triageRow, prompt_version_short: triageRow.prompt_version.replace(/^triage-/, "") } : null;

  const fbId = recordFeedback(db, {
    execName: senderExec?.display_name ?? `slack:${sender}`,
    targetType: "message_exemplar",
    targetId: null,
    targetSlackChannelId: channel_id,
    targetSlackTs: slack_ts,
    body: dmText,
    sentiment: null,
    sourceTag: senderExec ? "exemplar-watched-exec" : "exemplar-non-watched",
  });

  // Bot ack-reply in the DM thread
  const ack = describeExemplar({
    message,
    channelName: channelRow?.name,
    authorName: authorRow?.full_name,
    currentTriage,
  });
  try {
    await postMessage({ channel: dmChannel, text: ack, threadTs: dmTs });
  } catch (err) {
    console.warn(`  exemplar ack reply failed: ${err.message}`);
  }
  console.log(`✓ exemplar → feedback#${fbId}: ${senderExec?.display_name ?? sender} → ${channel_id}/${slack_ts}`);
  return fbId;
}

async function handleReactionAdded({ event }, db) {
  const reactor = event?.user;
  const channel = event?.item?.channel;
  const ts = event?.item?.ts;
  if (!reactor || !channel || !ts) return;

  // First check if this is a reaction on a proposal DM — that drives apply/reject.
  const proposalDelivery = lookupProposalDeliveryByMessage(db, channel, ts);
  if (proposalDelivery) {
    await handleProposalReaction({ event, reactor, proposalDelivery }, db);
    return;
  }

  const delivery = lookupDeliveryByMessage(db, channel, ts);
  if (!delivery) return; // Not on a digest message we sent — ignore.

  const reactorExec = lookupExecBySlackUserId(db, reactor);
  if (!reactorExec) {
    console.log(`Reaction from non-watched user ${reactor} on escalation #${delivery.escalation_id} — recording as non-authoritative.`);
  }

  const sentiment = REACTION_TO_SENTIMENT[event.reaction] ?? "other";
  const fbId = recordFeedback(db, {
    execName: reactorExec?.display_name ?? `slack:${reactor}`,
    targetType: "escalation",
    targetId: delivery.escalation_id,
    body: `:${event.reaction}: reaction on escalation #${delivery.escalation_id}`,
    sentiment,
    sourceTag: reactorExec ? "reaction-watched-exec" : "reaction-non-watched",
  });
  console.log(`✓ reaction → feedback#${fbId}: ${reactorExec?.display_name ?? reactor} :${event.reaction}: → escalation #${delivery.escalation_id} (${sentiment})`);
}

async function handleProposalReaction({ event, reactor, proposalDelivery }, db) {
  const proposalId = proposalDelivery.proposal_id;
  const reactorExec = lookupExecBySlackUserId(db, reactor);
  if (!reactorExec) {
    console.log(`Reaction from non-watched user ${reactor} on proposal #${proposalId} — ignoring (only watched execs can apply/reject).`);
    return;
  }

  let decision = null;
  if (ACCEPT_REACTIONS.has(event.reaction)) decision = "accept";
  else if (REJECT_REACTIONS.has(event.reaction)) decision = "reject";

  // Always record the reaction as feedback so Tier C sees it.
  const sentiment = REACTION_TO_SENTIMENT[event.reaction] ?? "other";
  recordFeedback(db, {
    execName: reactorExec.display_name,
    targetType: "criterion_proposal",
    targetId: proposalId,
    body: `:${event.reaction}: reaction on proposal #${proposalId}`,
    sentiment,
    sourceTag: "proposal-reaction-watched-exec",
  });

  if (!decision) return; // ambiguous emoji — recorded but no apply

  // Confirm in the DM thread that we're acting on it.
  const versionBefore = buildPromptVersion(db);
  try {
    await postMessage({
      channel: proposalDelivery.bot_message_channel,
      text: `:hourglass_flowing_sand: Applying proposal #${proposalId}…`,
      threadTs: proposalDelivery.bot_message_ts,
    });
  } catch { /* best-effort */ }

  let result;
  try {
    result = await applyProposal(db, proposalId, { decision, decidedBy: reactorExec.display_name });
  } catch (err) {
    console.error(`apply proposal #${proposalId} failed: ${err.message}`);
    try {
      await postMessage({
        channel: proposalDelivery.bot_message_channel,
        text: `:warning: Couldn't apply proposal #${proposalId}: ${err.message}`,
        threadTs: proposalDelivery.bot_message_ts,
      });
    } catch { /* best-effort */ }
    return;
  }

  const versionAfter = buildPromptVersion(db);
  const bumped = versionAfter !== versionBefore;
  let summary;
  if (result.skipped) {
    summary = `:information_source: Proposal #${proposalId} was already ${result.status} — no action taken.`;
  } else if (decision === "reject") {
    summary = `:wastebasket: Rejected proposal #${proposalId}. Tier C will see your decision in the next reflection.`;
  } else {
    const where = result.applied?.table ?? "?";
    const what = result.applied?.code ?? result.applied?.id ?? "";
    summary = `:white_check_mark: Applied proposal #${proposalId} → \`${where}\`${what ? ` (${what})` : ""}.`
      + `\nPrompt version: \`${versionBefore}\` → \`${versionAfter}\` ${bumped ? ":sparkles: bumped" : "(unchanged)"}.`
      + `\nNext triage run will use the updated prompt automatically.`;
  }

  try {
    await postMessage({
      channel: proposalDelivery.bot_message_channel,
      text: summary,
      threadTs: proposalDelivery.bot_message_ts,
    });
  } catch { /* best-effort */ }
  console.log(`✓ proposal #${proposalId} ${decision}ed by ${reactorExec.display_name}; prompt ${versionBefore} → ${versionAfter}`);
}

async function handleMessage({ event }, db) {
  // Only DMs to the bot (channel_type === 'im').
  if (event?.channel_type !== "im") return;
  // Ignore bot/own messages.
  if (event?.bot_id || event?.subtype === "bot_message") return;
  if (!event?.user || !event?.text) return;

  const sender = event.user;
  const senderExec = lookupExecBySlackUserId(db, sender);
  if (!senderExec) {
    console.log(`DM from non-watched user ${sender} — recording as non-authoritative.`);
  }

  // Detect Slack message links — exec is pointing at a specific message
  // they want flagged (or said should NOT have been flagged).
  const links = parseSlackMessageLinks(event.text);
  if (links.length > 0) {
    for (const link of links) {
      try {
        await handleExemplar(db, {
          senderExec, sender,
          dmChannel: event.channel, dmTs: event.ts,
          dmText: event.text,
          link,
        });
      } catch (err) {
        console.error(`  exemplar handler failed: ${err.message}`);
      }
    }
    // If the DM was ONLY links (no surrounding guidance), we're done.
    // If there's also free-text, fall through and ALSO record as guidance —
    // exec might have explained their reasoning and we want both signals.
    const stripped = event.text.replace(/<?https:\/\/[\w.-]+\.slack\.com\/archives\/\S+>?/g, "").trim();
    if (stripped.length < 20) return;
    // else fall through to record general guidance
  }

  // If this is a thread reply on a proposal DM, attribute to that proposal.
  if (event.thread_ts) {
    const proposalDelivery = lookupProposalDeliveryByMessage(db, event.channel, event.thread_ts);
    if (proposalDelivery) {
      const fbId = recordFeedback(db, {
        execName: senderExec?.display_name ?? `slack:${sender}`,
        targetType: "criterion_proposal",
        targetId: proposalDelivery.proposal_id,
        body: event.text,
        sentiment: null,
        sourceTag: senderExec ? "proposal-reply-watched-exec" : "proposal-reply-non-watched",
      });
      try {
        await postMessage({
          channel: event.channel,
          text: `:bookmark_tabs: Got it — captured as feedback on proposal #${proposalDelivery.proposal_id}. React :white_check_mark: on the parent message to apply, :x: to reject, or keep refining here.`,
          threadTs: event.thread_ts,
        });
      } catch { /* best-effort ack */ }
      console.log(`✓ proposal-thread reply → feedback#${fbId}: ${senderExec?.display_name ?? sender} on proposal #${proposalDelivery.proposal_id}`);
      return;
    }
  }

  // If this is a thread reply on a digest message, attribute to that escalation.
  if (event.thread_ts) {
    const delivery = lookupDeliveryByMessage(db, event.channel, event.thread_ts);
    if (delivery) {
      const fbId = recordFeedback(db, {
        execName: senderExec?.display_name ?? `slack:${sender}`,
        targetType: "escalation",
        targetId: delivery.escalation_id,
        body: event.text,
        sentiment: null,
        sourceTag: senderExec ? "thread-reply-watched-exec" : "thread-reply-non-watched",
      });
      try {
        await postMessage({
          channel: event.channel,
          text: `:bookmark_tabs: Got it — captured as feedback on escalation #${delivery.escalation_id}. Tier C will incorporate on the next reflection.`,
          threadTs: event.thread_ts,
        });
      } catch (err) { /* best-effort ack */ }
      console.log(`✓ thread reply → feedback#${fbId}: ${senderExec?.display_name ?? sender} on escalation #${delivery.escalation_id}`);
      return;
    }
  }

  // General DM feedback (free-text guidance like "I want to know when X happens")
  const fbId = recordFeedback(db, {
    execName: senderExec?.display_name ?? `slack:${sender}`,
    targetType: "general",
    targetId: null,
    body: event.text,
    sentiment: null,
    sourceTag: senderExec ? "dm-watched-exec" : "dm-non-watched",
  });
  // Ack so the user knows we got it
  try {
    await postMessage({
      channel: event.channel,
      text: `:bookmark_tabs: Got it. Tier C will fold this into the next reflection (proposes calibration changes from feedback). If you want me to use a specific Slack message as a labeled exemplar, paste its link and I'll capture the message itself.`,
      threadTs: event.ts,
    });
  } catch (err) { /* best-effort ack */ }
  console.log(`✓ general DM → feedback#${fbId}: ${senderExec?.display_name ?? sender}: ${event.text.slice(0, 80)}…`);
}

async function main() {
  const { appToken } = getEnv();
  const db = openDatabase();

  const sm = new SocketModeClient({ appToken });

  sm.on("reaction_added", async ({ event, ack }) => {
    try { await ack(); } catch { /* SDK auto-acks; ignore */ }
    try { await handleReactionAdded({ event }, db); } catch (err) { console.error("reaction_added handler error:", err.message); }
  });

  sm.on("message", async ({ event, ack }) => {
    try { await ack(); } catch { /* ignore */ }
    try { await handleMessage({ event }, db); } catch (err) { console.error("message handler error:", err.message); }
  });

  sm.on("app_mention", async ({ event, ack }) => {
    try { await ack(); } catch { /* ignore */ }
    // Mentions in channels — record as general feedback from the mentioner.
    if (!event?.user || !event?.text) return;
    const senderExec = lookupExecBySlackUserId(db, event.user);
    const fbId = recordFeedback(db, {
      execName: senderExec?.display_name ?? `slack:${event.user}`,
      targetType: "general",
      targetId: null,
      body: event.text,
      sentiment: null,
      sourceTag: senderExec ? "app-mention-watched-exec" : "app-mention-non-watched",
    });
    console.log(`✓ app_mention → feedback#${fbId}: ${senderExec?.display_name ?? event.user}`);
  });

  sm.on("connecting", () => console.log("[socket-mode] connecting…"));
  sm.on("authenticated", () => console.log("[socket-mode] authenticated"));
  sm.on("connected", () => console.log("[socket-mode] connected — listening for events"));
  sm.on("disconnecting", () => console.log("[socket-mode] disconnecting"));
  sm.on("disconnected", () => console.log("[socket-mode] disconnected"));
  sm.on("error", (err) => console.error("[socket-mode] error:", err?.message ?? err));

  await sm.start();
  console.log("Listener running. Ctrl-C to stop.");
}

try { await main(); } catch (e) { console.error(e instanceof Error ? e.stack : String(e)); process.exit(1); }
