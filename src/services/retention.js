'use strict';

// Execution log retention.
//
// `executions` is written on every auth, every failure and every tamper report,
// and nothing ever removed a row. It is also the table the hot path reads on
// each request and the one every dashboard number is computed from, so it does
// not merely grow — it makes everything slower as it grows, and the SQLite file
// with it.
//
// The auth checks only ever look back an hour (sharing window, key throttle), so
// nothing older than that has to stay in raw form. Days past the retention
// window are folded into executions_daily and their rows dropped: the charts
// keep their history, the hot path keeps its small table.

const db = require('../db');
const config = require('../config');

const DAY = 86400;
const today = () => Math.floor(Date.now() / 1000 / DAY);

/**
 * Fold completed days older than the retention window into the rollup, then
 * delete the raw rows. Idempotent — re-running it changes nothing.
 *
 * @returns {{days:number, rows:number}} days rolled up and raw rows removed
 */
function rollup() {
  const cutoffDay = today() - Math.max(1, config.executionsRetentionDays);
  const cutoff = cutoffDay * DAY;

  // Only whole days that are entirely behind the cutoff, so a day still being
  // written to is never half-rolled.
  const days = db
    .prepare(
      `SELECT DISTINCT script_id, CAST(created_at / ${DAY} AS INTEGER) AS day
         FROM executions
        WHERE created_at < ? AND script_id IS NOT NULL`
    )
    .all(cutoff);

  if (!days.length) return { days: 0, rows: 0 };

  const aggregate = db.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(success), 0) AS successes,
            COUNT(DISTINCT hwid) AS unique_hwids
       FROM executions
      WHERE script_id = ? AND created_at >= ? AND created_at < ?`
  );
  const upsert = db.prepare(
    `INSERT INTO executions_daily (script_id, day, total, successes, unique_hwids)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(script_id, day) DO UPDATE SET
       total        = total + excluded.total,
       successes    = successes + excluded.successes,
       unique_hwids = MAX(unique_hwids, excluded.unique_hwids)`
  );

  let rows = 0;
  db.transaction(() => {
    for (const { script_id, day } of days) {
      const from = day * DAY;
      const to = from + DAY;
      const agg = aggregate.get(script_id, from, to);
      if (!agg.total) continue;
      upsert.run(script_id, day, agg.total, agg.successes, agg.unique_hwids);
      rows += agg.total;
    }
    db.prepare(`DELETE FROM executions WHERE created_at < ?`).run(cutoff);
  })();

  return { days: days.length, rows };
}

/** Daily totals for a script over a window, rollup and raw rows combined. */
function dailyFor(scriptId, sinceDays) {
  const since = today() - sinceDays;
  const merged = new Map();

  for (const r of db
    .prepare('SELECT day, total, successes FROM executions_daily WHERE script_id = ? AND day >= ? ORDER BY day')
    .all(scriptId, since)) {
    merged.set(r.day, { date: r.day * DAY, total: r.total, successes: r.successes });
  }

  for (const r of db
    .prepare(
      `SELECT CAST(created_at / ${DAY} AS INTEGER) AS day,
              COUNT(*) AS total,
              COALESCE(SUM(success), 0) AS successes
         FROM executions
        WHERE script_id = ? AND created_at >= ?
        GROUP BY day ORDER BY day`
    )
    .all(scriptId, since * DAY)) {
    const prev = merged.get(r.day);
    merged.set(r.day, {
      date: r.day * DAY,
      total: (prev ? prev.total : 0) + r.total,
      successes: (prev ? prev.successes : 0) + r.successes,
    });
  }

  return [...merged.values()].sort((a, b) => a.date - b.date);
}

/** Start the periodic sweep. Unref'd, so it never holds the process open. */
function start() {
  if (!config.executionsRetentionDays) return null;
  const timer = setInterval(() => {
    try {
      rollup();
    } catch (err) {
      console.error('[2t1auth] retention sweep failed:', err.message);
    }
  }, config.retentionSweepMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { rollup, dailyFor, start };
