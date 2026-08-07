'use strict';
// Live sessions: heartbeats, revocation that reaches a running script, and
// concurrency as a key-sharing signal.

const path = require('node:path');
const os = require('node:os');
const nodeCrypto = require('node:crypto');
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef0123';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.DB_PATH = path.join(
  os.tmpdir(),
  `2t1auth-lease-${process.pid}-${nodeCrypto.randomBytes(4).toString('hex')}.db`
);

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const config = require('../src/config');
const scripts = require('../src/services/scripts');
const keys = require('../src/services/keys');
const lease = require('../src/services/lease');
const { authenticate } = require('../src/services/auth');

function mk(opts = {}) {
  const script = scripts.createScript({ name: 'Lease Test', source: '__R = 1', hwid_lock: 0, ...opts });
  const [key] = keys.createKeys(script.id, { count: 1 });
  return { script, key };
}

/** Run `fn` with config overrides, restoring them afterwards. */
function withConfig(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) {
    saved[k] = config[k];
    config[k] = patch[k];
  }
  try {
    return fn();
  } finally {
    Object.assign(config, saved);
  }
}

test.beforeEach(() => lease.reset());

test('a successful auth opens a live session', () => {
  const { script, key } = mk();
  const r = authenticate({ scriptId: script.id, key: key.value, executor: 'synapse' });
  assert.ok(r.success);
  assert.ok(r.lease, 'no lease was issued');
  assert.strictEqual(lease.countFor(key.id), 1);
});

test('beats must increase, so a captured one cannot be replayed', () => {
  const { script, key } = mk();
  const { lease: id } = authenticate({ scriptId: script.id, key: key.value, executor: 'synapse' });

  assert.ok(lease.beat(id, 1).ok);
  assert.ok(lease.beat(id, 2).ok);
  // Replaying beat 2, or going backwards, is refused.
  assert.strictEqual(lease.beat(id, 2).ok, false);
  assert.strictEqual(lease.beat(id, 1).ok, false);
  assert.ok(lease.beat(id, 3).ok);
});

test('banning a key ends the session already running', () => {
  const { script, key } = mk();
  const { lease: id } = authenticate({ scriptId: script.id, key: key.value, executor: 'synapse' });
  assert.ok(lease.get(id), 'session should start alive');

  keys.updateKey(key.id, { status: 'banned' });

  assert.strictEqual(lease.get(id), null, 'the running session survived a ban');
  assert.strictEqual(lease.beat(id, 1).ok, false);
});

test('deleting a key ends its session too', () => {
  const { script, key } = mk();
  const { lease: id } = authenticate({ scriptId: script.id, key: key.value, executor: 'synapse' });
  keys.deleteKey(key.id);
  assert.strictEqual(lease.get(id), null);
});

test('a second seat evicts the first and is recorded as concurrent use', () => {
  const { script, key } = mk();
  const first = authenticate({ scriptId: script.id, key: key.value, hwid: 'DEV-A', executor: 'synapse' });
  const second = authenticate({ scriptId: script.id, key: key.value, hwid: 'DEV-B', executor: 'synapse' });

  // The newcomer wins the seat — a user whose game crashed can rejoin at once
  // rather than waiting out the lease TTL…
  assert.strictEqual(lease.get(first.lease), null, 'the first seat should have been evicted');
  assert.ok(lease.get(second.lease));
  assert.strictEqual(lease.countFor(key.id), 1);

  // …but the eviction itself is logged, which is the actual sharing signal.
  const reasons = db
    .prepare('SELECT reason FROM executions WHERE key_id = ? ORDER BY id')
    .all(key.id)
    .map((r) => r.reason);
  assert.ok(reasons.includes('concurrent_session'), `expected a concurrency signal, got ${reasons.join(',')}`);
});

test('more seats can be granted for keys sold as multi-device', () => {
  const { script, key } = mk();
  withConfig({ leaseMaxPerKey: 3 }, () => {
    const a = authenticate({ scriptId: script.id, key: key.value, hwid: 'A', executor: 'synapse' });
    const b = authenticate({ scriptId: script.id, key: key.value, hwid: 'B', executor: 'synapse' });
    const c = authenticate({ scriptId: script.id, key: key.value, hwid: 'C', executor: 'synapse' });

    assert.strictEqual(lease.countFor(key.id), 3);
    for (const r of [a, b, c]) assert.ok(lease.get(r.lease), 'a seat within the limit was evicted');

    // The fourth pushes the oldest out.
    authenticate({ scriptId: script.id, key: key.value, hwid: 'D', executor: 'synapse' });
    assert.strictEqual(lease.countFor(key.id), 3);
    assert.strictEqual(lease.get(a.lease), null);
  });
});

test('an expired lease stops answering', () => {
  const { script, key } = mk();
  const { lease: id } = withConfig({ leaseTtlMs: 10000 }, () =>
    authenticate({ scriptId: script.id, key: key.value, executor: 'synapse' })
  );

  const rec = lease._store.get(id);
  rec.expires = Date.now() - 1;

  assert.strictEqual(lease.get(id), null);
  assert.strictEqual(lease.beat(id, 1).ok, false);
  assert.strictEqual(lease.countFor(key.id), 0);
});

test('leases are off when the feature is disabled', () => {
  const { script, key } = mk();
  withConfig({ heartbeat: false }, () => {
    const r = authenticate({ scriptId: script.id, key: key.value, executor: 'synapse' });
    assert.ok(r.success);
    assert.strictEqual(r.lease, undefined);
  });
});
