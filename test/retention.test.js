'use strict';
// Execution-log retention: old rows are folded into a daily rollup and dropped,
// without the dashboard losing the history it charts.

const path = require('node:path');
const os = require('node:os');
const nodeCrypto = require('node:crypto');
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef0123';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.DB_PATH = path.join(
  os.tmpdir(),
  `2t1auth-retention-${process.pid}-${nodeCrypto.randomBytes(4).toString('hex')}.db`
);

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const config = require('../src/config');
const scripts = require('../src/services/scripts');
const retention = require('../src/services/retention');
const { scriptStats } = require('../src/services/stats');

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

/** Write execution rows `daysAgo` days back. */
function seed(scriptId, daysAgo, { count = 10, successes = count, hwids = 3 } = {}) {
  const at = now() - daysAgo * DAY;
  const ins = db.prepare(
    `INSERT INTO executions (key_id, script_id, hwid, ip, executor, success, reason, created_at)
     VALUES (NULL, ?, ?, ?, 'synapse', ?, 'ok', ?)`
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      ins.run(scriptId, `HW-${i % hwids}`, '203.0.113.1', i < successes ? 1 : 0, at);
    }
  })();
}

const rawCount = (scriptId) =>
  db.prepare('SELECT COUNT(*) AS n FROM executions WHERE script_id = ?').get(scriptId).n;
const rollupRows = (scriptId) =>
  db.prepare('SELECT * FROM executions_daily WHERE script_id = ? ORDER BY day').all(scriptId);

test('old rows are rolled up and removed, recent ones are left alone', () => {
  const s = scripts.createScript({ name: 'Retention' });
  seed(s.id, 30, { count: 10, successes: 7, hwids: 3 });
  seed(s.id, 20, { count: 6, successes: 6, hwids: 2 });
  seed(s.id, 1, { count: 4, successes: 4, hwids: 1 }); // inside the window
  assert.strictEqual(rawCount(s.id), 20);

  const out = retention.rollup();
  assert.strictEqual(out.rows, 16, 'wrong number of rows folded up');

  // The recent day survives untouched.
  assert.strictEqual(rawCount(s.id), 4);

  const rolled = rollupRows(s.id);
  assert.strictEqual(rolled.length, 2);
  assert.deepStrictEqual(
    rolled.map((r) => [r.total, r.successes, r.unique_hwids]),
    [
      [10, 7, 3],
      [6, 6, 2],
    ]
  );
});

test('running the sweep again changes nothing', () => {
  const s = scripts.createScript({ name: 'Idempotent' });
  seed(s.id, 40, { count: 5 });

  retention.rollup();
  const first = rollupRows(s.id);
  retention.rollup();
  assert.deepStrictEqual(rollupRows(s.id), first, 'a second sweep double-counted');
});

test('the chart keeps its history after the raw rows are gone', () => {
  const s = scripts.createScript({ name: 'Charted' });
  seed(s.id, 25, { count: 8, successes: 5 });
  seed(s.id, 2, { count: 3, successes: 3 });

  const before = scriptStats(s.id, { sinceDays: 60 }).daily;
  retention.rollup();
  const after = scriptStats(s.id, { sinceDays: 60 }).daily;

  assert.deepStrictEqual(after, before, 'pruning changed what the chart shows');
  assert.strictEqual(
    after.reduce((n, d) => n + d.total, 0),
    11
  );
});

test('a day is never half-rolled', () => {
  // Rows from today are still being written; they must stay raw whatever the
  // retention window says, or a sweep would drop part of a live day.
  const s = scripts.createScript({ name: 'Today' });
  seed(s.id, 0, { count: 5 });

  const saved = config.executionsRetentionDays;
  config.executionsRetentionDays = 0; // as aggressive as the config allows
  try {
    retention.rollup();
  } finally {
    config.executionsRetentionDays = saved;
  }
  assert.strictEqual(rawCount(s.id), 5, "today's rows were pruned");
});

test('nothing to do is not an error', () => {
  const s = scripts.createScript({ name: 'Empty' });
  assert.deepStrictEqual(retention.rollup(), { days: 0, rows: 0 });
  assert.deepStrictEqual(scriptStats(s.id, { sinceDays: 7 }).daily, []);
});
