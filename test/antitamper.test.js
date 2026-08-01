'use strict';
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef0123';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.ALLOWED_EXECUTORS = 'synapse,scriptware';
process.env.KEY_SHARE_MAX_HWIDS = '2';
process.env.DB_PATH = path.join(os.tmpdir(), `2t1auth-at-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const config = require('../src/config');
const scripts = require('../src/services/scripts');
const keys = require('../src/services/keys');
const { authenticate, reportTamper, checkHwid, cleanExecutor } = require('../src/services/auth');

function mk(opts = {}) {
  const s = scripts.createScript({ name: 'AT', source: 'return 1', hwid_lock: 0, obfuscate: 0, ...opts });
  const [k] = keys.createKeys(s.id, { count: 1 });
  return { s, k };
}

/** Temporarily override config for one test. */
function withConfig(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = config[k];
    config[k] = overrides[k];
  }
  try {
    fn();
  } finally {
    Object.assign(config, saved);
  }
}

const reasonsFor = (keyId) =>
  db
    .prepare('SELECT reason FROM executions WHERE key_id = ? ORDER BY id')
    .all(keyId)
    .map((r) => r.reason);

/* ------------------------------ executors ------------------------------ */

test('executor allowlist: an allowed executor passes', () => {
  const { s, k } = mk();
  assert.ok(authenticate({ scriptId: s.id, key: k.value, executor: 'Synapse' }).success);
});

test('executor allowlist: a non-listed executor is rejected', () => {
  const { s, k } = mk();
  assert.strictEqual(authenticate({ scriptId: s.id, key: k.value, executor: 'RandomExec' }).code, 403);
});

test('executor names are sanitised before matching and storage', () => {
  assert.strictEqual(cleanExecutor('Sc|ript Wa`re'), 'Script Ware');
  assert.strictEqual(cleanExecutor('x'.repeat(200)).length, 64);
  assert.strictEqual(cleanExecutor('|||'), null);
  assert.strictEqual(cleanExecutor(null), null);
  // "|" separates the fields the session proof hashes — it must never survive.
  assert.ok(!cleanExecutor('a|b').includes('|'));
});

/* --------------------------------- HWID --------------------------------- */

test('HWID validation rejects junk, placeholders and oversized values', () => {
  assert.ok(checkHwid('ABCD-1234_ef.gh:0').ok);
  assert.strictEqual(checkHwid('').reason, 'no_hwid');
  assert.strictEqual(checkHwid('a'.repeat(config.hwidMaxLength + 1)).reason, 'hwid_too_long');
  assert.strictEqual(checkHwid('has space').reason, 'bad_hwid');
  assert.strictEqual(checkHwid('pipe|char').reason, 'bad_hwid');
  for (const junk of ['unknown', 'UNKNOWN', 'nil', 'null', '0', '00000000-0000-0000-0000-000000000000']) {
    assert.strictEqual(checkHwid(junk).reason, 'placeholder_hwid', junk);
  }
});

test('a placeholder HWID never binds a locked key', () => {
  const { s, k } = mk({ hwid_lock: 1 });
  const r = authenticate({ scriptId: s.id, key: k.value, hwid: 'unknown', executor: 'synapse' });
  assert.ok(!r.success);
  assert.strictEqual(r.code, 400);
  // Nothing was bound, so a real device can still claim the key afterwards.
  assert.strictEqual(keys.getKeyById(k.id).hwid, null);
  assert.ok(authenticate({ scriptId: s.id, key: k.value, hwid: 'REAL-DEVICE-1', executor: 'synapse' }).success);
});

test('first use binds the key, a second device is refused', () => {
  const { s, k } = mk({ hwid_lock: 1 });
  assert.ok(authenticate({ scriptId: s.id, key: k.value, hwid: 'DEV-A', executor: 'synapse' }).success);
  assert.strictEqual(keys.getKeyById(k.id).hwid, 'DEV-A');

  const r = authenticate({ scriptId: s.id, key: k.value, hwid: 'DEV-B', executor: 'synapse' });
  assert.strictEqual(r.code, 403);
  assert.match(r.message, /HWID mismatch/);
  assert.strictEqual(keys.getKeyById(k.id).hwid, 'DEV-A', 'binding was overwritten');
});

test('binding is atomic: a device that loses the race does not also get in', () => {
  const { s, k } = mk({ hwid_lock: 1 });
  // Stand in for the interleaving: another request bound the key between this
  // one reading the row and writing its own HWID. The conditional UPDATE must
  // not clobber it, and this caller must be refused.
  db.prepare('UPDATE keys SET hwid = ? WHERE id = ?').run('DEV-WINNER', k.id);
  const bound = db.prepare('UPDATE keys SET hwid = ? WHERE id = ? AND hwid IS NULL').run('DEV-LOSER', k.id);
  assert.strictEqual(bound.changes, 0, 'conditional bind overwrote an existing HWID');

  const r = authenticate({ scriptId: s.id, key: k.value, hwid: 'DEV-LOSER', executor: 'synapse' });
  assert.strictEqual(r.code, 403);
  assert.strictEqual(keys.getKeyById(k.id).hwid, 'DEV-WINNER');
});

test('an oversized HWID is refused, not silently truncated', () => {
  const { s, k } = mk({ hwid_lock: 1 });
  const long = 'A'.repeat(config.hwidMaxLength + 50);
  assert.strictEqual(authenticate({ scriptId: s.id, key: k.value, hwid: long, executor: 'synapse' }).code, 400);
  assert.strictEqual(keys.getKeyById(k.id).hwid, null);
});

/* ----------------------------- key sharing ----------------------------- */

test('key-sharing: auto-bans after too many distinct HWIDs', () => {
  const { s, k } = mk(); // hwid_lock off so multiple HWIDs are allowed to run
  assert.ok(authenticate({ scriptId: s.id, key: k.value, hwid: 'H1', executor: 'synapse' }).success);
  assert.ok(authenticate({ scriptId: s.id, key: k.value, hwid: 'H2', executor: 'synapse' }).success);

  // 3rd distinct HWID exceeds KEY_SHARE_MAX_HWIDS (2) -> auto-ban + reject
  const r = authenticate({ scriptId: s.id, key: k.value, hwid: 'H3', executor: 'synapse' });
  assert.ok(!r.success);
  assert.match(r.message, /sharing/i);
  assert.strictEqual(keys.getKeyById(k.id).status, 'banned');
});

test('key-sharing: auto-bans after too many distinct IPs', () => {
  const { s, k } = mk();
  withConfig({ keyShareMaxHwids: 0, keyShareMaxIps: 2 }, () => {
    // Same spoofed HWID every time — only the network gives the sharing away.
    const call = (ip) => authenticate({ scriptId: s.id, key: k.value, hwid: 'SAME', ip, executor: 'synapse' });
    assert.ok(call('1.1.1.1').success);
    assert.ok(call('2.2.2.2').success);
    const r = call('3.3.3.3');
    assert.ok(!r.success);
    assert.strictEqual(keys.getKeyById(k.id).status, 'banned');
    assert.ok(reasonsFor(k.id).includes('auto_banned_sharing_ip'));
  });
});

test('key-sharing never counts failed attempts (no griefing a stranger key)', () => {
  const { s, k } = mk({ hwid_lock: 1 });
  assert.ok(authenticate({ scriptId: s.id, key: k.value, hwid: 'OWNER', executor: 'synapse' }).success);
  // Someone who merely knows the key sprays HWIDs at it: all fail on the lock…
  for (const h of ['ATT-1', 'ATT-2', 'ATT-3', 'ATT-4']) {
    assert.ok(!authenticate({ scriptId: s.id, key: k.value, hwid: h, executor: 'synapse' }).success);
  }
  // …and the owner is still fine.
  assert.strictEqual(keys.getKeyById(k.id).status, 'active');
  assert.ok(authenticate({ scriptId: s.id, key: k.value, hwid: 'OWNER', executor: 'synapse' }).success);
});

test('per-key throttle slows a key down without banning it', () => {
  const { s, k } = mk();
  withConfig({ keyRateMax: 2, keyRateWindowMs: 60000 }, () => {
    assert.ok(authenticate({ scriptId: s.id, key: k.value, executor: 'synapse' }).success);
    assert.ok(authenticate({ scriptId: s.id, key: k.value, executor: 'synapse' }).success);
    const r = authenticate({ scriptId: s.id, key: k.value, executor: 'synapse' });
    assert.strictEqual(r.code, 429);
    assert.strictEqual(keys.getKeyById(k.id).status, 'active', 'throttling should not ban');
  });
});

/* --------------------------- session delivery --------------------------- */

test('a session-keyed delivery carries no key of its own', () => {
  const { s, k } = mk({ obfuscate: 1, source: 'print("MARKER_XYZ")' });
  const session = { salt: 'a-salt-value', nonce: 'a-nonce-value' };
  const r = authenticate({ scriptId: s.id, key: k.value, hwid: 'DEV', executor: 'synapse', session });

  assert.ok(r.success);
  assert.strictEqual(r.enc, 'session');
  assert.ok(!r.script.includes('MARKER_XYZ'));
  // Inline mode writes the key as B64("..."); session mode must not.
  assert.ok(!/=\w+\("[A-Za-z0-9+/=]+"\)/.test(r.script), 'session payload still embeds a key');
});

test('without a session the delivery falls back to a self-contained payload', () => {
  const { s, k } = mk({ obfuscate: 1, source: 'print("MARKER_XYZ")' });
  const r = authenticate({ scriptId: s.id, key: k.value, hwid: 'DEV', executor: 'synapse', session: null });
  assert.ok(r.success);
  assert.strictEqual(r.enc, undefined);
  assert.ok(!r.script.includes('MARKER_XYZ'));
});

test('an unprotected script is still delivered verbatim', () => {
  const { s, k } = mk({ obfuscate: 0, source: 'print("PLAIN")' });
  const r = authenticate({ scriptId: s.id, key: k.value, executor: 'synapse' });
  assert.strictEqual(r.script, 'print("PLAIN")');
});

/* ---------------------------- tamper reports ---------------------------- */

test('a tamper report is recorded against the key', () => {
  const { s, k } = mk();
  assert.ok(reportTamper({ scriptId: s.id, key: k.value, hwid: 'DEV', reason: 'hook:http' }).success);
  assert.ok(reasonsFor(k.id).includes('client_tamper:hook:http'));
});

test('tamper reports cannot smuggle junk into the log', () => {
  const { s, k } = mk();
  reportTamper({ scriptId: s.id, key: k.value, reason: "'; DROP TABLE keys; --" + 'x'.repeat(200) });
  const logged = reasonsFor(k.id).find((r) => r.startsWith('client_tamper:'));
  assert.match(logged, /^client_tamper:[a-z0-9:_-]{1,32}$/i);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM keys').get().n > 0, 'keys table survived');
});

test('a tamper report for an unknown script is refused', () => {
  assert.strictEqual(reportTamper({ scriptId: 'nope', key: 'x', reason: 'hook:http' }).code, 404);
});

test('reports can auto-ban once the threshold is set', () => {
  const { s, k } = mk();
  withConfig({ tamperReportBan: 2 }, () => {
    reportTamper({ scriptId: s.id, key: k.value, reason: 'hook:http' });
    assert.strictEqual(keys.getKeyById(k.id).status, 'active');
    reportTamper({ scriptId: s.id, key: k.value, reason: 'hook:http' });
    assert.strictEqual(keys.getKeyById(k.id).status, 'banned');
  });
});

test('reports are advisory only — off by default they never ban', () => {
  const { s, k } = mk();
  for (let i = 0; i < 20; i++) reportTamper({ scriptId: s.id, key: k.value, reason: 'hook:http' });
  assert.strictEqual(keys.getKeyById(k.id).status, 'active');
});
