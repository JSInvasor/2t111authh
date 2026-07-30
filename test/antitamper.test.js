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
const scripts = require('../src/services/scripts');
const keys = require('../src/services/keys');
const { authenticate } = require('../src/services/auth');

function mk(opts = {}) {
  const s = scripts.createScript({ name: 'AT', source: 'return 1', hwid_lock: 0, obfuscate: 0, ...opts });
  const [k] = keys.createKeys(s.id, { count: 1 });
  return { s, k };
}

test('executor allowlist: an allowed executor passes', () => {
  const { s, k } = mk();
  assert.ok(authenticate({ scriptId: s.id, key: k.value, executor: 'Synapse' }).success);
});

test('executor allowlist: a non-listed executor is rejected', () => {
  const { s, k } = mk();
  assert.strictEqual(authenticate({ scriptId: s.id, key: k.value, executor: 'RandomExec' }).code, 403);
});

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
