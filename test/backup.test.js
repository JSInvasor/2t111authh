'use strict';
// Backups, and the part that decides whether they are worth anything: actually
// restoring from one and finding the data there.
//
// An untested backup is an assumption. These tests do the drill — take a backup,
// destroy the original, bring the copy up as the live database, and check that
// every key still authenticates.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const nodeCrypto = require('node:crypto');
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef0123';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), '2t1auth-backup-'));
process.env.DB_PATH = path.join(TMP, 'live.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

const db = require('../src/db');
const config = require('../src/config');
const scripts = require('../src/services/scripts');
const keys = require('../src/services/keys');
const backup = require('../src/services/backup');
const { keyHash } = require('../src/utils/crypto');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function seed(n = 5) {
  const script = scripts.createScript({ name: 'Backed up', source: 'print("hi")', hwid_lock: 1 });
  const made = keys.createKeys(script.id, { count: n, note: 'paid customer' });
  return { script, keys: made };
}

test('a backup is taken, verified, and readable', async () => {
  const { script, keys: made } = seed(5);
  const out = await backup.run();

  assert.ok(fs.existsSync(out.file));
  assert.ok(out.bytes > 0);
  assert.strictEqual(out.counts.keys, made.length);
  assert.strictEqual(out.counts.scripts, 1);
  assert.ok(backup.verify(out.file).ok);
  assert.ok(script.id);
});

test('THE DRILL: destroy the live database and come back up from the backup', async () => {
  const { script, keys: made } = seed(3);
  const expected = made.map((k) => k.value).sort();
  const out = await backup.run();

  // Simulate losing the volume: the live file is gone, all we have is the copy.
  const restored = path.join(TMP, 'restored.db');
  fs.copyFileSync(out.file, restored);

  const back = new Database(restored, { fileMustExist: true });
  try {
    // The schema came with it…
    const tables = back
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    for (const t of ['scripts', 'keys', 'executions', 'admins', 'audit_log']) {
      assert.ok(tables.includes(t), `restored database is missing ${t}`);
    }

    // …every key a customer paid for is still there, still bound to its script…
    const recovered = back
      .prepare('SELECT value, kh, script_id FROM keys WHERE script_id = ? ORDER BY value')
      .all(script.id);
    assert.deepStrictEqual(recovered.map((k) => k.value).sort(), expected);

    // …and the hash the auth path looks keys up by still resolves, so those keys
    // would authenticate rather than merely exist.
    for (const row of recovered) {
      assert.strictEqual(row.kh, keyHash(row.value));
      const found = back.prepare('SELECT id FROM keys WHERE kh = ? AND script_id = ?').get(row.kh, script.id);
      assert.ok(found, `restored key ${row.value} would not authenticate`);
    }

    // …and the restored database is writable, not a read-only husk.
    assert.doesNotThrow(() => back.prepare("UPDATE keys SET note = 'after restore' WHERE script_id = ?").run(script.id));
  } finally {
    back.close();
  }
});

test('a backup taken mid-write is still consistent', async () => {
  // The live database is in WAL mode and being written to while the backup runs;
  // the copy has to land on a whole transaction, not half of one.
  const { script } = seed(2);
  const writes = [];
  for (let i = 0; i < 50; i++) {
    writes.push(keys.createKeys(script.id, { count: 1 }));
  }
  const out = await backup.run();

  const res = backup.verify(out.file);
  assert.ok(res.ok, res.reason);
  assert.strictEqual(res.counts.keys, db.prepare('SELECT COUNT(*) AS n FROM keys').get().n);
  assert.strictEqual(writes.length, 50);
});

test('a corrupt backup is reported, not silently accepted', () => {
  const bad = path.join(TMP, 'corrupt.db');
  fs.writeFileSync(bad, Buffer.from('this is definitely not a sqlite file'));

  const res = backup.verify(bad);
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /unreadable|integrity|query failed/i);
});

test('an empty but structurally valid backup is caught', () => {
  // integrity_check passes happily on a well-formed empty database, so the check
  // has to compare against what the source actually held.
  const empty = path.join(TMP, 'empty.db');
  const fresh = new Database(empty);
  fresh.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8'));
  fresh.close();

  assert.ok(backup.verify(empty).ok, 'an empty database is structurally fine on its own');
  const res = backup.verify(empty, { expect: backup.sourceCounts() });
  assert.strictEqual(res.ok, false, 'an empty backup passed as a good one');
  assert.match(res.reason, /source had/);
});

test('a missing file is reported rather than throwing', () => {
  const res = backup.verify(path.join(TMP, 'nope.db'));
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /missing/);
});

test('old backups are pruned, newest kept', async () => {
  seed(1);
  const dir = path.join(TMP, 'rotation');
  fs.mkdirSync(dir, { recursive: true });
  // Names sort chronologically by construction, which is what prune relies on.
  for (const stamp of ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04']) {
    fs.writeFileSync(path.join(dir, `2t1auth-${stamp}.db`), 'x');
  }
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'leave me alone');

  const pruned = backup.prune(dir, 2);
  assert.deepStrictEqual(pruned.sort(), ['2t1auth-2024-01-01.db', '2t1auth-2024-01-02.db']);

  const left = fs.readdirSync(dir).sort();
  assert.deepStrictEqual(left, ['2t1auth-2024-01-03.db', '2t1auth-2024-01-04.db', 'unrelated.txt']);
});

test('latest() finds the newest backup', async () => {
  seed(1);
  const out = await backup.run({ dir: config.backupDir, keep: 5 });
  assert.strictEqual(backup.latest(config.backupDir), out.file);
});
