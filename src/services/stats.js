'use strict';

const db = require('../db');

/** Aggregate analytics for a single script/project. */
function scriptStats(scriptId, { sinceDays = 7 } = {}) {
  const since = Math.floor(Date.now() / 1000) - sinceDays * 86400;

  const executions = db
    .prepare(
      `SELECT
         COUNT(*)                          AS total,
         COALESCE(SUM(success), 0)         AS successes,
         COALESCE(SUM(1 - success), 0)     AS failures,
         COUNT(DISTINCT hwid)              AS unique_hwids
       FROM executions
       WHERE script_id = ? AND created_at >= ?`
    )
    .get(scriptId, since);

  const keys = db
    .prepare(
      `SELECT
         COUNT(*)                                                   AS total,
         COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END), 0) AS active,
         COALESCE(SUM(CASE WHEN status='banned' THEN 1 ELSE 0 END), 0) AS banned,
         COALESCE(SUM(CASE WHEN status='paused' THEN 1 ELSE 0 END), 0) AS paused,
         COALESCE(SUM(CASE WHEN hwid IS NOT NULL THEN 1 ELSE 0 END), 0) AS bound,
         COALESCE(SUM(CASE WHEN expires_at IS NOT NULL AND expires_at < strftime('%s','now') THEN 1 ELSE 0 END), 0) AS expired
       FROM keys
       WHERE script_id = ?`
    )
    .get(scriptId);

  const recent = db
    .prepare(
      `SELECT created_at, success, reason, hwid, executor, ip
       FROM executions
       WHERE script_id = ?
       ORDER BY created_at DESC
       LIMIT 20`
    )
    .all(scriptId);

  // Daily execution counts for the window (for a simple chart).
  const daily = db
    .prepare(
      `SELECT CAST(created_at / 86400 AS INTEGER) AS day,
              COUNT(*) AS total,
              COALESCE(SUM(success), 0) AS successes
       FROM executions
       WHERE script_id = ? AND created_at >= ?
       GROUP BY day
       ORDER BY day`
    )
    .all(scriptId, since)
    .map((r) => ({ date: r.day * 86400, total: r.total, successes: r.successes }));

  return { window_days: sinceDays, executions, keys, recent, daily };
}

/** Aggregate analytics across all scripts (dashboard home). */
function overview() {
  const dayAgo = Math.floor(Date.now() / 1000) - 86400;
  const totals = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM scripts) AS scripts,
         (SELECT COUNT(*) FROM keys) AS keys,
         (SELECT COUNT(*) FROM keys WHERE status='active') AS active_keys,
         (SELECT COUNT(*) FROM keys WHERE hwid IS NOT NULL) AS bound_keys,
         (SELECT COUNT(*) FROM executions WHERE created_at >= ?) AS executions_24h,
         (SELECT COUNT(DISTINCT hwid) FROM executions WHERE created_at >= ? AND success=1) AS active_users_24h
       `
    )
    .get(dayAgo, dayAgo);

  const topScripts = db
    .prepare(
      `SELECT s.id, s.name,
              (SELECT COUNT(*) FROM executions e WHERE e.script_id = s.id AND e.created_at >= ?) AS executions_24h,
              (SELECT COUNT(*) FROM keys k WHERE k.script_id = s.id) AS keys
       FROM scripts s
       ORDER BY executions_24h DESC
       LIMIT 5`
    )
    .all(dayAgo);

  return { totals, topScripts };
}

module.exports = { scriptStats, overview };
