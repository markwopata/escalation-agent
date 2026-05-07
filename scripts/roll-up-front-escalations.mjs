// Roll up Tier B Front investigations into escalations.
//
// Front conversations cluster differently from Slack messages:
//   - Each conversation IS already a thread (no need for thread-level clustering).
//   - We cluster across conversations by:
//       1. recipient_handle (same customer email writing in multiple times) → "customer" cluster
//       2. inbox + primary_criterion → "inbox_criterion" cluster
//       3. fallback singleton
//
// Output rows go into the same `escalations` table with source='front', so
// the existing digest pipeline can consume them.
//
// Usage:
//   npm run rollup:front

import process from "node:process";
import { openDatabase, nowIso } from "./lib/db.mjs";

const ROLLUP_VERSION = "front-rollup-v3-broader-extract";
const CUSTOMER_CLUSTER_MIN = 2;        // 2+ conversations from same customer
const CUSTOMER_CLUSTER_DAYS = 14;
const INBOX_CRIT_CLUSTER_MIN = 3;       // 3+ conversations same inbox+criterion
const INBOX_CRIT_CLUSTER_DAYS = 7;

// Extract a stable customer identity from a Front conversation. The previous
// version grouped by `recipient_handle` — but that's the ES INTAKE address
// (e.g. hello@equipmentshare.com), not the customer. Result: 15 unrelated
// service requests from 15 different customers got bundled into one
// escalation just because they all came in via hello@.
//
// Real customer identity sources, in priority order:
//   1. Subject pattern "Service Request from {name} | {COMPANY} ({account_id})"
//      → account_id is the canonical customer key
//   2. Body pattern "Customer ID: {N}" or "Account: {N}" or "Account #X"
//      embedded in the structured intake form
//   3. Body pattern "Customer Information: ... Email: <addr>"
//      → use the customer's actual email
//   4. Subject pattern without account_id → normalized company name
//   5. "Re: Service Request Received on Asset #N for {Name}" → asset number
//   6. "Website Contact from {name}" → sender name
//   7. Quote-tool subjects "Quote # {N}" → quote number (rare cluster)
//   8. Otherwise → null (fall through to singleton)
//
// Returns a key string or null. Two conversations with the same key are the
// same customer; null means we couldn't identify so don't group.
export function extractFrontCustomerKey(conv, firstTurnText = null) {
  const subject = conv.subject ?? "";

  // Pattern 1: Service Request from X | COMPANY (account_id)
  const svc = subject.match(/Service Request from\s+.+?\s*\|\s*(.+?)(?:\s*\(([0-9]+)\))?\s*$/);
  if (svc?.[2]) return `acct:${svc[2]}`;

  // Pattern 2: account_id from the structured body of intake forms.
  // Common phrasings: "Customer ID: 78157", "Account: 78157", "Account #78157",
  // "(account 78157)". Look in the body text if provided.
  if (firstTurnText) {
    const bodyAcct = firstTurnText.match(/(?:Customer\s+ID|Account(?:\s+#|:)?)\s*[:#]?\s*([0-9]{4,7})\b/i);
    if (bodyAcct) return `acct:${bodyAcct[1]}`;
    const parenAcct = firstTurnText.match(/\(account\s+([0-9]{4,7})\)/i);
    if (parenAcct) return `acct:${parenAcct[1]}`;
  }

  // Pattern 3: customer email from the structured Customer Information block.
  if (firstTurnText) {
    const customerEmail = firstTurnText.match(/Customer Information[\s\S]{0,400}?Email:\s*([\w.+-]+@[\w.-]+\.\w+)/i);
    if (customerEmail) {
      const email = customerEmail[1].toLowerCase();
      // Skip ES domains and known generic addresses
      if (!email.endsWith("@equipmentshare.com") && !email.startsWith("hello@") && !email.startsWith("info@")) {
        // Use the email's domain as the key — multiple complaints from the same
        // customer org typically share a domain even when the sender varies.
        const domain = email.split("@")[1];
        if (domain && domain.length >= 4) return `domain:${domain}`;
      }
    }
  }

  // Pattern 4: subject company name (no account_id)
  if (svc?.[1]) {
    const company = svc[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (company.length >= 3) return `company:${company}`;
  }

  // Pattern 5: Re: Service Request Received on Asset #N for {Name}
  const asset = subject.match(/Service Request Received on Asset #([0-9]+)\s+for\s+(.+)$/i);
  if (asset) return `asset:${asset[1]}`;

  // Pattern 6: Website Contact from {name}
  const web = subject.match(/Website Contact from\s+(.+)$/i);
  if (web) {
    const sender = web[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (sender.length >= 3) return `web:${sender}`;
  }

  // Pattern 7: Quote # N references — useful when the same customer's quote
  // gets followed up across multiple inbox emails.
  const quote = subject.match(/Quote\s*#\s*([0-9]{6,8})\b/i)
             ?? firstTurnText?.match(/Quote\s+Number[\s:]+([0-9]{6,8})/i);
  if (quote) return `quote:${quote[1]}`;

  return null;
}

function daysBetween(a, b) {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
}

function unionCriteria(members) {
  const set = new Set();
  for (const m of members) set.add(m.primary_criterion);
  return [...set];
}

function pickRepresentative(members) {
  const sorted = [...members].sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0));
  return sorted[0];
}

function dominantCriterion(members) {
  const counts = new Map();
  for (const m of members) counts.set(m.primary_criterion, (counts.get(m.primary_criterion) ?? 0) + 1);
  let best = null, bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return best;
}

function buildClusters(investigations) {
  // Only escalate-decision investigations roll up; monitor/dismiss don't go to digest.
  const escalating = investigations.filter(i => i.decision === "escalate");
  const clusters = [];
  const assigned = new Map();

  // Pass 1: customer clusters (same EXTRACTED CUSTOMER IDENTITY)
  // Each investigation has a precomputed `customer_key` from extractFrontCustomerKey().
  // Investigations with no customer_key (null) skip the customer-cluster pass and
  // fall through to inbox_criterion or singleton.
  const byCustomer = new Map();
  for (const i of escalating) {
    if (!i.customer_key) continue;
    if (!byCustomer.has(i.customer_key)) byCustomer.set(i.customer_key, []);
    byCustomer.get(i.customer_key).push(i);
  }
  for (const [customerKey, members] of byCustomer) {
    if (members.length < CUSTOMER_CLUSTER_MIN) continue;
    members.sort((a, b) => new Date(a.conversation_created_at) - new Date(b.conversation_created_at));
    let current = [];
    for (const m of members) {
      if (!current.length || daysBetween(current[0].conversation_created_at, m.conversation_created_at) <= CUSTOMER_CLUSTER_DAYS) {
        current.push(m);
      } else {
        if (current.length >= CUSTOMER_CLUSTER_MIN) {
          clusters.push({
            cluster_type: "front_customer",
            cluster_key: `front_customer::${customerKey}::${current[0].conversation_created_at.slice(0, 10)}`,
            members: current,
            primary_criterion: dominantCriterion(current),
            customer_key: customerKey,
          });
          for (const x of current) assigned.set(x.id, true);
        }
        current = [m];
      }
    }
    if (current.length >= CUSTOMER_CLUSTER_MIN) {
      clusters.push({
        cluster_type: "front_customer",
        cluster_key: `front_customer::${customerKey}::${current[0].conversation_created_at.slice(0, 10)}`,
        members: current,
        primary_criterion: dominantCriterion(current),
        customer_key: customerKey,
      });
      for (const x of current) assigned.set(x.id, true);
    }
  }

  // Pass 2: inbox+criterion clusters from leftovers
  const byInboxCrit = new Map();
  for (const i of escalating) {
    if (assigned.has(i.id)) continue;
    const k = `${i.inbox_id}::${i.primary_criterion}`;
    if (!byInboxCrit.has(k)) byInboxCrit.set(k, []);
    byInboxCrit.get(k).push(i);
  }
  for (const [k, members] of byInboxCrit) {
    if (members.length < INBOX_CRIT_CLUSTER_MIN) continue;
    members.sort((a, b) => new Date(a.conversation_created_at) - new Date(b.conversation_created_at));
    let current = [];
    for (const m of members) {
      if (!current.length || daysBetween(current[0].conversation_created_at, m.conversation_created_at) <= INBOX_CRIT_CLUSTER_DAYS) {
        current.push(m);
      } else {
        if (current.length >= INBOX_CRIT_CLUSTER_MIN) {
          clusters.push({
            cluster_type: "front_inbox_criterion",
            cluster_key: `front_inbox_crit::${k}::${current[0].conversation_created_at.slice(0, 10)}`,
            members: current,
            primary_criterion: dominantCriterion(current),
          });
          for (const x of current) assigned.set(x.id, true);
        }
        current = [m];
      }
    }
    if (current.length >= INBOX_CRIT_CLUSTER_MIN) {
      clusters.push({
        cluster_type: "front_inbox_criterion",
        cluster_key: `front_inbox_crit::${k}::${current[0].conversation_created_at.slice(0, 10)}`,
        members: current,
        primary_criterion: dominantCriterion(current),
      });
      for (const x of current) assigned.set(x.id, true);
    }
  }

  // Pass 3: singleton fallback
  for (const i of escalating) {
    if (assigned.has(i.id)) continue;
    clusters.push({
      cluster_type: "front_singleton",
      cluster_key: `front_singleton::${i.id}`,
      members: [i],
      primary_criterion: i.primary_criterion,
    });
    assigned.set(i.id, true);
  }

  return clusters;
}

const UPSERT_ESCALATION = `
INSERT INTO escalations (
  cluster_key, rollup_version, cluster_type,
  author_slack_user_id, slack_channel_id, primary_criterion, criteria_observed_json,
  max_severity, evidence_investigation_ids_json, evidence_message_count,
  representative_investigation_id, representative_exec_summary, representative_recommended_actions_json,
  first_evidence_at, last_evidence_at, signal_event_at, created_at,
  source, front_conversation_id, front_inbox_id, front_investigation_id
) VALUES (
  @cluster_key, @rollup_version, @cluster_type,
  NULL, NULL, @primary_criterion, @criteria_observed_json,
  @max_severity, @evidence_investigation_ids_json, @evidence_message_count,
  NULL, @representative_exec_summary, @representative_recommended_actions_json,
  @first_evidence_at, @last_evidence_at, @signal_event_at, @created_at,
  'front', @front_conversation_id, @front_inbox_id, @front_investigation_id
)
ON CONFLICT (cluster_key, rollup_version) DO UPDATE SET
  cluster_type = excluded.cluster_type,
  primary_criterion = excluded.primary_criterion,
  criteria_observed_json = excluded.criteria_observed_json,
  max_severity = excluded.max_severity,
  evidence_investigation_ids_json = excluded.evidence_investigation_ids_json,
  evidence_message_count = excluded.evidence_message_count,
  representative_exec_summary = excluded.representative_exec_summary,
  representative_recommended_actions_json = excluded.representative_recommended_actions_json,
  first_evidence_at = excluded.first_evidence_at,
  last_evidence_at = excluded.last_evidence_at,
  signal_event_at = excluded.signal_event_at,
  source = excluded.source,
  front_conversation_id = excluded.front_conversation_id,
  front_inbox_id = excluded.front_inbox_id,
  front_investigation_id = excluded.front_investigation_id
WHERE escalations.exec_action = 'pending'
`;

// Find the most recent customer turn timestamp across all the cluster's
// member conversations. This is the dedupe-relevant signal — when the
// customer follows up, signal_event_at advances past the prior delivery
// timestamp and the escalation becomes re-eligible. Returns null if no
// customer turns exist (rare for Front; would mean the rollup filters
// missed an ES-only conversation, but we handle gracefully).
function computeSignalEventAt(db, conversationIds) {
  if (!conversationIds.length) return null;
  const placeholders = conversationIds.map(() => "?").join(",");
  const r = db.prepare(`
    SELECT MAX(created_at) AS latest
    FROM front_messages
    WHERE role = 'customer' AND conversation_id IN (${placeholders})
  `).get(...conversationIds);
  return r?.latest ?? null;
}

function persistCluster(db, cluster) {
  const rep = pickRepresentative(cluster.members);
  const ids = cluster.members.map(m => m.id);
  const times = cluster.members.map(m => m.conversation_created_at).filter(Boolean).sort();
  const allActions = [];
  for (const m of cluster.members) {
    try { for (const a of JSON.parse(m.recommended_actions_json ?? "[]")) allActions.push(a); } catch {}
  }
  // Dedup actions, keep first 8.
  const seen = new Set();
  const dedup = [];
  for (const a of allActions) {
    const key = a.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(a);
    if (dedup.length >= 8) break;
  }
  const memberConvIds = [...new Set(cluster.members.map(m => m.conversation_id).filter(Boolean))];
  const signalEventAt = computeSignalEventAt(db, memberConvIds);
  const params = {
    cluster_key: cluster.cluster_key,
    rollup_version: ROLLUP_VERSION,
    cluster_type: cluster.cluster_type,
    primary_criterion: cluster.primary_criterion,
    criteria_observed_json: JSON.stringify(unionCriteria(cluster.members)),
    max_severity: Math.max(...cluster.members.map(m => m.severity ?? 1)),
    evidence_investigation_ids_json: JSON.stringify(ids),
    evidence_message_count: cluster.members.length,
    representative_exec_summary: rep.exec_summary,
    representative_recommended_actions_json: JSON.stringify(dedup),
    first_evidence_at: times[0] ?? null,
    last_evidence_at: times[times.length - 1] ?? null,
    signal_event_at: signalEventAt,
    created_at: nowIso(),
    front_conversation_id: rep.conversation_id,
    front_inbox_id: rep.inbox_id,
    front_investigation_id: rep.id,
  };
  db.prepare(UPSERT_ESCALATION).run(params);
}

async function main() {
  const db = openDatabase();
  // Pull all front_investigations joined with conversation context.
  const rawInvestigations = db.prepare(`
    SELECT fi.id, fi.front_triage_run_id, fi.conversation_id, fi.inbox_id,
           fi.decision, fi.severity, fi.exec_summary, fi.rationale,
           fi.recommended_actions_json,
           fc.subject, fc.recipient_handle, fc.recipient_role,
           fc.conversation_created_at,
           fc.inbox_name, ftr.primary_criterion
    FROM front_investigations fi
    JOIN front_conversations fc ON fc.conversation_id = fi.conversation_id
    JOIN front_triage_runs ftr ON ftr.id = fi.front_triage_run_id
    WHERE fi.prompt_version = 'front-investigate-v1'
  `).all();
  // Compute customer_key for each. Conversations whose subject doesn't match
  // any known intake pattern get null → fall through to inbox_criterion or singleton.
  // Pull the first inbound message body for body-based extraction (account_id
  // in structured form, customer email domain).
  const firstTurnByConv = new Map();
  const firstTurns = db.prepare(`
    SELECT conversation_id, text FROM front_messages
    WHERE turn_index = 1
  `).all();
  for (const t of firstTurns) firstTurnByConv.set(t.conversation_id, t.text ?? "");
  let investigations = rawInvestigations.map(i => ({
    ...i,
    customer_key: extractFrontCustomerKey(i, firstTurnByConv.get(i.conversation_id)),
  }));

  // Exclude 1-turn auto-WORKFLOW conversations:
  //   (a) auto-quote emails (SendGrid URL pattern from the quotes tool)
  //   (b) service-intake forms (structured Customer Information + Asset Information body)
  // Per Mark's directive: standalone automated form submissions are workflow,
  // not escalation, even when archived-without-reply. Don't recreate as
  // escalations under the new rollup. Multi-turn conversations (where a human
  // followed up) still go through normal rollup.
  const beforeAutoFilter = investigations.length;
  const autoQuoteConvs = new Set(db.prepare(`
    SELECT fc.conversation_id
    FROM front_conversations fc
    WHERE fc.total_message_count = 1
      AND EXISTS (
        SELECT 1 FROM front_messages fm
        WHERE fm.conversation_id = fc.conversation_id
          AND fm.text LIKE '%u51874413.ct.sendgrid.net%'
      )
  `).all().map(r => r.conversation_id));
  const intakeFormConvs = new Set(db.prepare(`
    SELECT fc.conversation_id
    FROM front_conversations fc
    WHERE fc.total_message_count = 1
      AND EXISTS (
        SELECT 1 FROM front_messages fm
        WHERE fm.conversation_id = fc.conversation_id
          AND fm.text LIKE '%Customer Information:%'
          AND fm.text LIKE '%Asset Information:%'
      )
  `).all().map(r => r.conversation_id));
  // Quote-approval emails: body contains "quote below has been approved" or
  // "Rental Request Summary" — these are templated quote-tool outputs sent
  // to sales inboxes when a quote is approved. Silenced when the only
  // INGESTED message is the templated quote (no follow-up visible to the
  // pipeline). Per Mark's 2026-05-07 directive: "those quote emails...
  // unless there is a customer or employee follow-up, should not be in the
  // escalation bot."
  //
  // Note: we use ingested-turn count (front_messages), not Snowflake's
  // total_message_count. Many of these conversations show total=2 in
  // Snowflake but we've only pulled 1 turn — the rollup can't see the
  // follow-up either, so the resulting Tier B summary just describes the
  // templated quote body. If the second turn is a real human follow-up,
  // a future ingest will pull it in and the rollup will re-evaluate.
  const quoteApprovalConvs = new Set(db.prepare(`
    SELECT conversation_id FROM (
      SELECT fm.conversation_id,
             COUNT(*) AS ingested_turn_count,
             MAX(CASE
               WHEN fm.text LIKE '%quote below has been approved%' OR fm.text LIKE '%Rental Request Summary%'
               THEN 1 ELSE 0
             END) AS has_quote_body
      FROM front_messages fm
      GROUP BY fm.conversation_id
    )
    WHERE ingested_turn_count = 1 AND has_quote_body = 1
  `).all().map(r => r.conversation_id));
  // Service-inbox 1-turn conversations: per Mark's directive, service tickets
  // require a CUSTOMER FOLLOW-UP to be escalatable. A 1-turn message landing
  // in a service inbox — whether from a customer's web form, a TAM's email
  // handoff, or a sales coordinator forwarding a request — is the handoff
  // itself, not the signal. Real signal is a follow-up that was ignored.
  // Inbox names match `% Service%` (e.g. "Tampa Service", "El Paso Service",
  // "Memphis Service", "Stargate - Abilene, TX - Onsite Yard - Service").
  const serviceInboxOneTurn = new Set(db.prepare(`
    SELECT fc.conversation_id
    FROM front_conversations fc
    WHERE fc.total_message_count = 1
      AND (fc.inbox_name LIKE '% Service' OR fc.inbox_name LIKE '%Service%' OR fc.inbox_name LIKE '%- Service%')
  `).all().map(r => r.conversation_id));
  // ES_EMPLOYEE-only service-inbox conversations (no customer turn ever):
  // generalizes the 1-turn rule to multi-turn internal handoffs. Per Mark's
  // 2026-05-02 directive: "if a message ever says From: EquipmentShare and
  // has a service inbox like this one it has to be excluded. It's an
  // automated email." The customer voice is the threshold for any service-
  // inbox escalation; without it, the conversation is ES employees
  // coordinating dispatch among themselves — pure workflow.
  const serviceInboxNoCustomer = new Set(db.prepare(`
    SELECT fc.conversation_id
    FROM front_conversations fc
    WHERE (fc.inbox_name LIKE '% Service' OR fc.inbox_name LIKE '%Service%' OR fc.inbox_name LIKE '%- Service%')
      AND NOT EXISTS (
        SELECT 1 FROM front_messages fm
        WHERE fm.conversation_id = fc.conversation_id
          AND fm.role = 'customer'
      )
  `).all().map(r => r.conversation_id));
  investigations = investigations.filter(i =>
    !autoQuoteConvs.has(i.conversation_id)
    && !intakeFormConvs.has(i.conversation_id)
    && !quoteApprovalConvs.has(i.conversation_id)
    && !serviceInboxOneTurn.has(i.conversation_id)
    && !serviceInboxNoCustomer.has(i.conversation_id)
  );
  const droppedAutoQuote = beforeAutoFilter - investigations.length;

  const withKey = investigations.filter(i => i.customer_key).length;
  console.log(`Loaded ${rawInvestigations.length} front_investigations`);
  console.log(`  − ${droppedAutoQuote} dropped as 1-turn auto-quote (SendGrid pattern)`);
  console.log(`  = ${investigations.length} eligible (${withKey} with extracted customer_key)`);

  const clusters = buildClusters(investigations);
  console.log(`Built ${clusters.length} clusters: ${clusters.filter(c => c.cluster_type === 'front_customer').length} customer, ${clusters.filter(c => c.cluster_type === 'front_inbox_criterion').length} inbox_criterion, ${clusters.filter(c => c.cluster_type === 'front_singleton').length} singletons.`);

  const txn = db.transaction(() => {
    for (const c of clusters) persistCluster(db, c);
  });
  txn();

  console.log(`Persisted Front escalations.`);
  // Show top
  const top = db.prepare(`
    SELECT id, max_severity, cluster_type, primary_criterion, evidence_message_count,
           SUBSTR(representative_exec_summary, 1, 120) AS preview
    FROM escalations
    WHERE source = 'front' AND rollup_version = ? AND exec_action = 'pending'
    ORDER BY max_severity DESC, last_evidence_at DESC LIMIT 30
  `).all(ROLLUP_VERSION);
  for (const t of top) {
    console.log(`  [sev ${t.max_severity}] ${t.cluster_type} | ${t.primary_criterion} | ${t.evidence_message_count} evid | ${t.preview}…`);
  }
}

await main();
