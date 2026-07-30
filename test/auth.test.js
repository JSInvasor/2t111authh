'use strict';
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef0123';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.BLOCKED_EXECUTORS = 'blockedexec';
process.env.DB_PATH = path.join(os.tmpdir(), `2t1auth-auth-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);

const test = require('node:test');
const assert = require('node:assert');
const scripts = require('../src/services/scripts');
const keys = require('../src/services/keys');
const { authenticate } = require('../src/services/auth');

function mk(opts = {}) {
  const s = scripts.createScript({ name: 'A', source: 'return 1', ...opts });
  const [k] = keys.createKeys(s.id, { count: 1 });
  return { s, k };
}

test('unknown script -> 404', () => {
  assert.strictEqual(authenticate({ scriptId: 'zzz', key: 'x' }).code, 404);
});

test('invalid key -> 401', () => {
  const { s } = mk();
  assert.strictEqual(authenticate({ scriptId: s.id, key: 'nope', hwid: 'H' }).code, 401);
});

test('HWID binds on first use, then mismatch is rejected', () => {
  const { s, k } = mk({ hwid_lock: 1, obfuscate: 0 });
  const ok = authenticate({ scriptId: s.id, key: k.value, hwid: 'HW1' });
  assert.ok(ok.success);
  assert.strictEqual(ok.script, 'return 1'); // obfuscation off -> plaintext
  const bad = authenticate({ scriptId: s.id, key: k.value, hwid: 'HW2' });
  assert.strictEqual(bad.code, 403);
});

test('banned / paused / expired keys are rejected', () => {
  const { s, k } = mk({ hwid_lock: 0 });
  keys.updateKey(k.id, { status: 'banned' });
  assert.ok(!authenticate({ scriptId: s.id, key: k.value }).success);
  keys.updateKey(k.id, { status: 'paused' });
  assert.ok(!authenticate({ scriptId: s.id, key: k.value }).success);
  keys.updateKey(k.id, { status: 'active', expires_at: 1 });
  assert.ok(!authenticate({ scriptId: s.id, key: k.value }).success);
});

test('disabled script -> 503', () => {
  const { s, k } = mk({ enabled: 0, hwid_lock: 0 });
  assert.strictEqual(authenticate({ scriptId: s.id, key: k.value }).code, 503);
});

test('blocked executor -> 403', () => {
  const { s, k } = mk({ hwid_lock: 0 });
  const r = authenticate({ scriptId: s.id, key: k.value, executor: 'BlockedExec' });
  assert.strictEqual(r.code, 403);
  assert.match(r.message, /executor/i);
});

test('obfuscated delivery does not leak the source', () => {
  const { s, k } = mk({ obfuscate: 1, hwid_lock: 0, source: 'print("LEAKTOKEN_XYZ")' });
  const r = authenticate({ scriptId: s.id, key: k.value });
  assert.ok(r.success);
  assert.ok(!r.script.includes('LEAKTOKEN_XYZ'));
  assert.ok(r.script.includes('loadstring or load'));
});

test('execution counter increments on success', () => {
  const { s, k } = mk({ hwid_lock: 0, obfuscate: 0 });
  authenticate({ scriptId: s.id, key: k.value });
  authenticate({ scriptId: s.id, key: k.value });
  assert.strictEqual(keys.getKeyById(k.id).total_executions, 2);
});
