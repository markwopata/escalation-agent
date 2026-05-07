// Pure DB-query helpers used by Tier B investigation tools. Each function
// takes the SQLite connection plus a small input object and returns plain
// JSON-serializable data. The Sonnet tool runner wraps these with Zod
// schemas (see investigate.mjs) and invokes them as needed.

export function fetchMessage(db, { slack_channel_id, slack_ts }) {
  const m = db.prepare(`
    SELECT m.*, c.name AS channel_name,
           v.full_name AS author_full_name,
           v.is_corporate AS author_is_corporate,
           v.employee_title AS author_title,
           v.department_or_function AS author_department,
           v.location AS author_location,
           v.employee_state AS author_state,
           v.tenure_years AS author_tenure_years
    FROM messages m
    JOIN channels c ON c.slack_channel_id = m.slack_channel_id
    LEFT JOIN v_employees_with_slack v ON v.slack_user_id = m.author_slack_user_id
    WHERE m.slack_channel_id = ? AND m.slack_ts = ?
  `).get(slack_channel_id, slack_ts);
  if (!m) return null;
  return {
    channel: m.channel_name,
    posted_at: m.message_posted_at,
    author: {
      full_name: m.author_full_name ?? m.author_username,
      is_corporate: m.author_is_corporate,
      title: m.author_title,
      department: m.author_department,
      location: m.author_location,
      state: m.author_state,
      tenure_years: m.author_tenure_years,
    },
    text: m.text,
    reply_count: m.reply_count,
    reactions_json: m.reactions_json,
  };
}

export function fetchThreadReplies(db, { slack_channel_id, thread_ts, limit = 30 }) {
  // Slack-style "thread replies" within our store: messages whose thread_ts equals the parent's.
  // We currently only ingest top-level messages, so this often returns just the parent.
  return db.prepare(`
    SELECT m.slack_ts, m.message_posted_at, m.text, m.author_username,
           v.full_name, v.is_corporate, v.employee_title, v.department_or_function
    FROM messages m
    LEFT JOIN v_employees_with_slack v ON v.slack_user_id = m.author_slack_user_id
    WHERE m.slack_channel_id = ?
      AND (m.thread_ts = ? OR m.slack_ts = ?)
    ORDER BY m.message_posted_at ASC
    LIMIT ?
  `).all(slack_channel_id, thread_ts, thread_ts, limit);
}

export function searchMessages(db, { query, since_iso, limit = 15 }) {
  // Naive LIKE search until we add FTS / embeddings. Good enough for prototype.
  const like = `%${query.toLowerCase()}%`;
  if (since_iso) {
    return db.prepare(`
      SELECT m.slack_channel_id, m.slack_ts, m.message_posted_at,
             c.name AS channel, v.full_name, v.is_corporate, v.department_or_function,
             SUBSTR(m.text, 1, 240) AS text_preview
      FROM messages m
      JOIN channels c ON c.slack_channel_id = m.slack_channel_id
      LEFT JOIN v_employees_with_slack v ON v.slack_user_id = m.author_slack_user_id
      WHERE LOWER(m.text) LIKE ?
        AND m.message_posted_at >= ?
      ORDER BY m.message_posted_at DESC
      LIMIT ?
    `).all(like, since_iso, limit);
  }
  return db.prepare(`
    SELECT m.slack_channel_id, m.slack_ts, m.message_posted_at,
           c.name AS channel, v.full_name, v.is_corporate, v.department_or_function,
           SUBSTR(m.text, 1, 240) AS text_preview
    FROM messages m
    JOIN channels c ON c.slack_channel_id = m.slack_channel_id
    LEFT JOIN v_employees_with_slack v ON v.slack_user_id = m.author_slack_user_id
    WHERE LOWER(m.text) LIKE ?
    ORDER BY m.message_posted_at DESC
    LIMIT ?
  `).all(like, limit);
}

export function getChannelHistory(db, { slack_channel_id, before_iso, limit = 20 }) {
  return db.prepare(`
    SELECT m.slack_ts, m.message_posted_at, m.text,
           v.full_name, v.is_corporate, v.employee_title, v.department_or_function
    FROM messages m
    LEFT JOIN v_employees_with_slack v ON v.slack_user_id = m.author_slack_user_id
    WHERE m.slack_channel_id = ?
      AND (? IS NULL OR m.message_posted_at < ?)
    ORDER BY m.message_posted_at DESC
    LIMIT ?
  `).all(slack_channel_id, before_iso ?? null, before_iso ?? null, limit);
}

export function lookupEmployee(db, { slack_user_id, employee_id, name }) {
  if (slack_user_id) {
    return db.prepare(`SELECT * FROM v_employees_with_slack WHERE slack_user_id = ?`).get(slack_user_id);
  }
  if (employee_id) {
    return db.prepare(`SELECT * FROM v_employees_with_slack WHERE employee_id = ?`).get(employee_id);
  }
  if (name) {
    return db.prepare(`SELECT * FROM v_employees_with_slack WHERE LOWER(full_name) = LOWER(?) LIMIT 1`).get(name);
  }
  return null;
}

export function findRelatedTriageFlags(db, { criterion, since_iso, limit = 20 }) {
  return db.prepare(`
    SELECT t.severity, t.primary_criterion, t.reason,
           c.name AS channel,
           m.message_posted_at,
           v.full_name AS author,
           v.is_corporate,
           SUBSTR(m.text, 1, 200) AS text_preview
    FROM triage_runs t
    JOIN messages m ON m.slack_channel_id = t.slack_channel_id AND m.slack_ts = t.slack_ts
    JOIN channels c ON c.slack_channel_id = m.slack_channel_id
    LEFT JOIN v_employees_with_slack v ON v.slack_user_id = m.author_slack_user_id
    WHERE t.worth_deeper_look = 1
      AND (t.primary_criterion = ? OR ? IN (
        SELECT json_each.value
        FROM json_each(t.criteria_matched_json)
      ))
      AND m.message_posted_at >= COALESCE(?, '1970-01-01')
    ORDER BY t.severity DESC, m.message_posted_at DESC
    LIMIT ?
  `).all(criterion, criterion, since_iso ?? null, limit);
}

export function countMessagesByAuthor(db, { slack_user_id, since_iso }) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM messages
    WHERE author_slack_user_id = ?
      AND message_posted_at >= COALESCE(?, '1970-01-01')
  `).get(slack_user_id, since_iso ?? null);
  return row?.n ?? 0;
}
