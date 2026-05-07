// Deduplication / clustering layer between Tier B investigations and the exec.
//
// Sonnet investigates each Tier-A flag independently and may escalate the same
// underlying issue multiple times (e.g., 4 separate escalations for the same
// person's manual-routing pattern). This script clusters escalate-decision
// investigations into one row per *underlying issue* so the exec sees a tight,
// deduplicated list.
//
// Clustering rules (idempotent, rule-based for now):
//
//   1. Same author with >= 2 escalate investigations within a 30-day window
//      → cluster type 'author', one escalation per author. Captures the
//      Liz-Hughson "this person keeps surfacing the same kind of thing" case.
//   2. Same channel + same primary_criterion with >= 2 escalate investigations
//      within a 7-day window → cluster type 'channel_criterion'. Captures the
//      "help-channel dead-air across multiple authors" case.
//   3. Anything left is its own singleton cluster.
//
// Each escalate investigation is assigned to ONE cluster. Author rule wins
// over channel_criterion when both apply. Re-running the script reconciles —
// existing clusters with manual exec_action preserved.
//
// LLM-merged exec_summary is left for a future enhancement; for now we pick
// the highest-severity-then-most-recent investigation as the cluster
// representative. The exec sees one summary per underlying issue plus an
// evidence count.

import process from "node:process";
import { openDatabase, nowIso } from "./lib/db.mjs";

const ROLLUP_VERSION = "rollup-v3-respect-retriage";
const AUTHOR_CLUSTER_DAYS = 30;
const CHANNEL_CRIT_CLUSTER_DAYS = 7;
const AUTHOR_CLUSTER_MIN_SIZE = 2;
const CHANNEL_CRIT_CLUSTER_MIN_SIZE = 2;

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node scripts/roll-up-escalations.mjs [--dry-run]");
      process.exit(0);
    }
  }
  return args;
}

function loadEscalateInvestigations(db) {
  // Pull all escalate-decision investigations + their triage context.
  const all = db.prepare(`
    SELECT
      i.id, i.triage_run_id, i.severity, i.exec_summary, i.recommended_actions_json,
      i.evidence_refs_json, i.full_response_json, i.ran_at,
      t.primary_criterion, t.criteria_matched_json, t.ran_at AS triage_ran_at,
      m.slack_channel_id, m.slack_ts, m.author_slack_user_id, m.message_posted_at,
      c.name AS channel_name
    FROM investigations i
    JOIN triage_runs t ON t.id = i.triage_run_id
    JOIN messages m ON m.slack_channel_id = t.slack_channel_id AND m.slack_ts = t.slack_ts
    JOIN channels c ON c.slack_channel_id = m.slack_channel_id
    WHERE i.decision = 'escalate'
    ORDER BY i.severity DESC, m.message_posted_at DESC
  `).all();

  // RESPECT RE-TRIAGE: Tier A may re-evaluate the same message under a newer
  // prompt version (e.g. Apex Hubbard light plants got re-classified from sev4
  // to sev1 when later prompts learned to ignore routine fleet allocation
  // posts). The old escalate-decision investigation lives forever in the DB
  // because we don't re-investigate, but if the LATEST triage on that exact
  // message has worth_deeper_look=0 OR severity<=2, the message has been
  // explicitly downgraded and the old investigation is stale signal.
  //
  // For each (channel, ts) we look up the most recent triage_run; if it's
  // a downgrade, we skip the old escalate investigation.
  const latestByMsg = new Map();
  const latestRows = db.prepare(`
    SELECT slack_channel_id, slack_ts, severity, worth_deeper_look, ran_at
    FROM triage_runs t1
    WHERE ran_at = (
      SELECT MAX(ran_at) FROM triage_runs t2
      WHERE t2.slack_channel_id = t1.slack_channel_id AND t2.slack_ts = t1.slack_ts
    )
  `).all();
  for (const r of latestRows) {
    latestByMsg.set(`${r.slack_channel_id}::${r.slack_ts}`, r);
  }

  let droppedByRetriage = 0;
  const filtered = all.filter(inv => {
    const key = `${inv.slack_channel_id}::${inv.slack_ts}`;
    const latest = latestByMsg.get(key);
    if (!latest) return true;  // no later triage → keep
    // Only drop if the LATEST triage is strictly newer than this investigation's
    // own triage AND classifies the message as not-worth-looking-at or trivial.
    if (new Date(latest.ran_at) <= new Date(inv.triage_ran_at)) return true;
    const downgraded = latest.worth_deeper_look === 0 || (latest.severity ?? 0) <= 2;
    if (downgraded) {
      droppedByRetriage += 1;
      return false;
    }
    return true;
  });
  if (droppedByRetriage > 0) {
    console.log(`  − ${droppedByRetriage} escalate investigations dropped because a newer Tier A re-triage of the same message classified it as not-worth-deeper-look or sev≤2`);
  }
  return filtered;
}

function daysBetween(aIso, bIso) {
  return Math.abs(new Date(aIso).getTime() - new Date(bIso).getTime()) / 86400000;
}

// Build clusters: author-first, then channel_criterion for the leftovers.
function buildClusters(investigations) {
  const assigned = new Map(); // investigation.id → cluster
  const clusters = []; // list of { type, key, members[], ... }

  // Pass 1: author clusters
  const byAuthor = new Map();
  for (const inv of investigations) {
    if (!inv.author_slack_user_id) continue;
    const k = inv.author_slack_user_id;
    if (!byAuthor.has(k)) byAuthor.set(k, []);
    byAuthor.get(k).push(inv);
  }
  for (const [authorId, members] of byAuthor) {
    if (members.length < AUTHOR_CLUSTER_MIN_SIZE) continue;
    members.sort((a, b) => new Date(a.message_posted_at) - new Date(b.message_posted_at));
    // Greedy split into 30-day windows
    let current = [];
    for (const m of members) {
      if (!current.length || daysBetween(current[0].message_posted_at, m.message_posted_at) <= AUTHOR_CLUSTER_DAYS) {
        current.push(m);
      } else {
        if (current.length >= AUTHOR_CLUSTER_MIN_SIZE) {
          clusters.push({
            cluster_type: "author",
            cluster_key: `author::${authorId}::${current[0].message_posted_at.slice(0,10)}`,
            members: current,
            author_slack_user_id: authorId,
            slack_channel_id: null,
            primary_criterion: dominantCriterion(current),
          });
          for (const x of current) assigned.set(x.id, clusters[clusters.length - 1]);
        }
        current = [m];
      }
    }
    if (current.length >= AUTHOR_CLUSTER_MIN_SIZE) {
      clusters.push({
        cluster_type: "author",
        cluster_key: `author::${authorId}::${current[0].message_posted_at.slice(0,10)}`,
        members: current,
        author_slack_user_id: authorId,
        slack_channel_id: null,
        primary_criterion: dominantCriterion(current),
      });
      for (const x of current) assigned.set(x.id, clusters[clusters.length - 1]);
    }
  }

  // Pass 2: channel_criterion clusters from leftovers
  const byChanCrit = new Map();
  for (const inv of investigations) {
    if (assigned.has(inv.id)) continue;
    const k = `${inv.slack_channel_id}::${inv.primary_criterion}`;
    if (!byChanCrit.has(k)) byChanCrit.set(k, []);
    byChanCrit.get(k).push(inv);
  }
  for (const [k, members] of byChanCrit) {
    if (members.length < CHANNEL_CRIT_CLUSTER_MIN_SIZE) continue;
    members.sort((a, b) => new Date(a.message_posted_at) - new Date(b.message_posted_at));
    let current = [];
    for (const m of members) {
      if (!current.length || daysBetween(current[0].message_posted_at, m.message_posted_at) <= CHANNEL_CRIT_CLUSTER_DAYS) {
        current.push(m);
      } else {
        if (current.length >= CHANNEL_CRIT_CLUSTER_MIN_SIZE) {
          clusters.push({
            cluster_type: "channel_criterion",
            cluster_key: `chan::${k}::${current[0].message_posted_at.slice(0,10)}`,
            members: current,
            author_slack_user_id: null,
            slack_channel_id: current[0].slack_channel_id,
            primary_criterion: current[0].primary_criterion,
          });
          for (const x of current) assigned.set(x.id, clusters[clusters.length - 1]);
        }
        current = [m];
      }
    }
    if (current.length >= CHANNEL_CRIT_CLUSTER_MIN_SIZE) {
      clusters.push({
        cluster_type: "channel_criterion",
        cluster_key: `chan::${k}::${current[0].message_posted_at.slice(0,10)}`,
        members: current,
        author_slack_user_id: null,
        slack_channel_id: current[0].slack_channel_id,
        primary_criterion: current[0].primary_criterion,
      });
      for (const x of current) assigned.set(x.id, clusters[clusters.length - 1]);
    }
  }

  // Pass 3: singletons
  for (const inv of investigations) {
    if (assigned.has(inv.id)) continue;
    clusters.push({
      cluster_type: "singleton",
      cluster_key: `singleton::inv-${inv.id}`,
      members: [inv],
      author_slack_user_id: inv.author_slack_user_id,
      slack_channel_id: inv.slack_channel_id,
      primary_criterion: inv.primary_criterion,
    });
  }

  return clusters;
}

function dominantCriterion(members) {
  const counts = new Map();
  for (const m of members) {
    counts.set(m.primary_criterion, (counts.get(m.primary_criterion) ?? 0) + 1);
  }
  let best = null, bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) { best = k; bestN = n; }
  }
  return best;
}

function pickRepresentative(members) {
  // Highest severity, then most recent message_posted_at, then most recent ran_at.
  return [...members].sort((a, b) => {
    if (b.severity !== a.severity) return (b.severity ?? 0) - (a.severity ?? 0);
    const dt = new Date(b.message_posted_at) - new Date(a.message_posted_at);
    if (dt !== 0) return dt;
    return new Date(b.ran_at) - new Date(a.ran_at);
  })[0];
}

function mergeRecommendedActions(members) {
  const out = new Map(); // key = lowercase first 80 chars
  for (const m of members) {
    let arr = [];
    try { arr = JSON.parse(m.recommended_actions_json ?? "[]"); } catch { arr = []; }
    for (const a of arr) {
      if (!a || typeof a !== "string") continue;
      const k = a.trim().toLowerCase().slice(0, 80);
      if (!out.has(k)) out.set(k, a);
    }
  }
  return Array.from(out.values()).slice(0, 8);
}

function unionCriteria(members) {
  const out = new Set();
  for (const m of members) {
    if (m.primary_criterion) out.add(m.primary_criterion);
    try {
      const arr = JSON.parse(m.criteria_matched_json ?? "[]");
      for (const c of arr) if (c) out.add(c);
    } catch { /* ignore */ }
  }
  return Array.from(out);
}

const UPSERT_ESCALATION_SQL = `
INSERT INTO escalations (
  cluster_key, rollup_version, cluster_type,
  author_slack_user_id, slack_channel_id, primary_criterion, criteria_observed_json,
  max_severity,
  evidence_investigation_ids_json, evidence_message_count,
  representative_investigation_id, representative_exec_summary, representative_recommended_actions_json,
  first_evidence_at, last_evidence_at, signal_event_at, created_at,
  exec_action
) VALUES (
  @cluster_key, @rollup_version, @cluster_type,
  @author_slack_user_id, @slack_channel_id, @primary_criterion, @criteria_observed_json,
  @max_severity,
  @evidence_investigation_ids_json, @evidence_message_count,
  @representative_investigation_id, @representative_exec_summary, @representative_recommended_actions_json,
  @first_evidence_at, @last_evidence_at, @signal_event_at, @created_at,
  'pending'
)
ON CONFLICT(rollup_version, cluster_key) DO UPDATE SET
  cluster_type = excluded.cluster_type,
  author_slack_user_id = excluded.author_slack_user_id,
  slack_channel_id = excluded.slack_channel_id,
  primary_criterion = excluded.primary_criterion,
  criteria_observed_json = excluded.criteria_observed_json,
  max_severity = MAX(escalations.max_severity, excluded.max_severity),
  evidence_investigation_ids_json = excluded.evidence_investigation_ids_json,
  evidence_message_count = excluded.evidence_message_count,
  representative_investigation_id = excluded.representative_investigation_id,
  representative_exec_summary = excluded.representative_exec_summary,
  representative_recommended_actions_json = excluded.representative_recommended_actions_json,
  first_evidence_at = MIN(escalations.first_evidence_at, excluded.first_evidence_at),
  last_evidence_at = MAX(escalations.last_evidence_at, excluded.last_evidence_at),
  signal_event_at = MAX(IFNULL(escalations.signal_event_at,''), IFNULL(excluded.signal_event_at,''))
WHERE escalations.exec_action = 'pending'
`;

function persistCluster(db, cluster) {
  const rep = pickRepresentative(cluster.members);
  const ids = cluster.members.map((m) => m.id);
  const times = cluster.members.map((m) => m.message_posted_at).filter(Boolean).sort();
  // Author-clusters span channels and previously stored slack_channel_id=null.
  // Default to the representative member's channel so per-recipient digest
  // filtering can route the escalation through channel_token_access.
  const channelId = cluster.slack_channel_id ?? rep.slack_channel_id ?? null;
  // signal_event_at for Slack: the most recent message_posted_at across the
  // cluster's member messages. Slack escalations don't naturally re-trigger
  // (new messages → new investigations → new clusters), so this is largely
  // anchored at the original post time. Re-deliveries via this field would
  // happen only if the same cluster_key gets new evidence appended (rare;
  // possible for author-clusters when the author posts again within the 30d
  // window).
  const slackSignalEventAt = times[times.length - 1] ?? null;
  const params = {
    cluster_key: cluster.cluster_key,
    rollup_version: ROLLUP_VERSION,
    cluster_type: cluster.cluster_type,
    author_slack_user_id: cluster.author_slack_user_id,
    slack_channel_id: channelId,
    primary_criterion: cluster.primary_criterion,
    criteria_observed_json: JSON.stringify(unionCriteria(cluster.members)),
    max_severity: Math.max(...cluster.members.map((m) => m.severity ?? 1)),
    evidence_investigation_ids_json: JSON.stringify(ids),
    evidence_message_count: cluster.members.length,
    representative_investigation_id: rep.id,
    representative_exec_summary: rep.exec_summary,
    representative_recommended_actions_json: JSON.stringify(mergeRecommendedActions(cluster.members)),
    first_evidence_at: times[0] ?? null,
    last_evidence_at: times[times.length - 1] ?? null,
    signal_event_at: slackSignalEventAt,
    created_at: nowIso(),
  };
  db.prepare(UPSERT_ESCALATION_SQL).run(params);
}

function main() {
  const args = parseArgs(process.argv);
  const db = openDatabase();

  const investigations = loadEscalateInvestigations(db);
  console.log(`Loaded ${investigations.length} escalate-decision investigations.`);

  const clusters = buildClusters(investigations);
  console.log(`Built ${clusters.length} clusters: ${clusters.filter(c => c.cluster_type === 'author').length} author, ${clusters.filter(c => c.cluster_type === 'channel_criterion').length} channel_criterion, ${clusters.filter(c => c.cluster_type === 'singleton').length} singletons.`);

  if (args.dryRun) {
    for (const c of clusters) {
      console.log(`  [${c.cluster_type}] ${c.cluster_key} (${c.members.length} members, sev≤${Math.max(...c.members.map(m => m.severity ?? 1))})`);
    }
    return;
  }

  const txn = db.transaction(() => {
    for (const c of clusters) persistCluster(db, c);
  });
  txn();

  const summary = db.prepare(`
    SELECT cluster_type, COUNT(*) AS n, SUM(evidence_message_count) AS evidence_total, AVG(max_severity) AS avg_sev
    FROM escalations
    WHERE rollup_version = ?
    GROUP BY cluster_type
  `).all(ROLLUP_VERSION);
  console.log("\nEscalation rollup:", summary);

  const top = db.prepare(`
    SELECT max_severity, cluster_type, primary_criterion, evidence_message_count,
           SUBSTR(representative_exec_summary, 1, 120) AS preview
    FROM escalations
    WHERE rollup_version = ? AND exec_action = 'pending'
    ORDER BY max_severity DESC, last_evidence_at DESC
  `).all(ROLLUP_VERSION);
  console.log("\nPending escalations for the exec:");
  for (const t of top) {
    console.log(`  [sev ${t.max_severity}] ${t.cluster_type} | ${t.primary_criterion} | ${t.evidence_message_count} evid | ${t.preview}…`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
