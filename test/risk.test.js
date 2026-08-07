'use strict';
// Risk scoring, environment pinning and fuzzy device matching.
//
// The thing worth testing here is not that abuse gets caught — it's that
// ordinary behaviour DOESN'T. Every false positive is a paying customer who
// can't run what they bought.

const path = require('node:path');
const os = require('node:os');
const nodeCrypto = require('node:crypto');
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef0123';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.DB_PATH = path.join(
  os.tmpdir(),
  `2t1auth-risk-${process.pid}-${nodeCrypto.randomBytes(4).toString('hex')}.db`
);

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const config = require('../src/config');
const scripts = require('../src/services/scripts');
const keys = require('../src/services/keys');
const lease = require('../src/services/lease');
const risk = require('../src/services/risk');
const { authenticate } = require('../src/services/auth');

const DEV_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DEV_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ENV_A = '1111111111111111111111111111111111111111111111111111111111111111';
const ENV_B = '2222222222222222222222222222222222222222222222222222222222222222';

function mk(opts = {}) {
  const script = scripts.createScript({ name: 'Risk', source: '__R = 1', hwid_lock: 1, ...opts });
  const [key] = keys.createKeys(script.id, { count: 1 });
  return { script, key };
}

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

/** Seed successful executions straight into the log. */
function seed(keyId, scriptId, rows) {
  const ins = db.prepare(
    `INSERT INTO executions (key_id, script_id, hwid, ip, executor, success, reason, created_at)
     VALUES (?, ?, ?, ?, 'synapse', ?, ?, ?)`
  );
  const at = Math.floor(Date.now() / 1000);
  db.transaction(() => {
    for (const r of rows) {
      ins.run(keyId, scriptId, r.hwid || null, r.ip || null, r.success ?? 1, r.reason || 'ok', at);
    }
  })();
}

test.beforeEach(() => lease.reset());

/* ------------------------- the false-positive cases ------------------------- */

test('one user on one device scores zero', () => {
  const { script, key } = mk();
  seed(key.id, script.id, Array.from({ length: 50 }, () => ({ hwid: 'DEV-1', ip: '203.0.113.5' })));
  assert.strictEqual(risk.score(key.id).score, 0);
});

test('a phone moving between networks is not treated as sharing', () => {
  // Wifi, then mobile data, then a different cell — one device, several
  // addresses. The old distinct-IP counter banned exactly this.
  const { script, key } = mk();
  seed(
    key.id,
    script.id,
    ['203.0.113.5', '198.51.100.20', '198.51.100.90', '192.0.2.7'].map((ip) => ({ hwid: 'DEV-1', ip }))
  );
  const { score } = risk.score(key.id);
  assert.ok(score < config.riskWatchAt, `a roaming phone scored ${score}`);
});

test('a household on one router is not treated as sharing', () => {
  const { script, key } = mk();
  seed(
    key.id,
    script.id,
    ['203.0.113.5', '203.0.113.6', '203.0.113.99'].map((ip) => ({ hwid: 'DEV-1', ip }))
  );
  assert.strictEqual(risk.score(key.id).score, 0, 'addresses in one /24 counted as separate networks');
});

test('two devices the user owns stay well under the ban line', () => {
  const { script, key } = mk();
  seed(key.id, script.id, [
    { hwid: 'LAPTOP', ip: '203.0.113.5' },
    { hwid: 'DESKTOP', ip: '203.0.113.6' },
  ]);
  const { score } = risk.score(key.id);
  assert.ok(score < config.riskBanAt, `two of the user's own devices scored ${score}`);
});

/* ---------------------------- the real patterns ---------------------------- */

test('many devices across many networks, displacing each other, is banned', () => {
  const { script, key } = mk();
  seed(key.id, script.id, [
    ...['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7'].map((hwid, i) => ({ hwid, ip: `203.0.${i}.5` })),
    ...Array.from({ length: 5 }, () => ({ success: 0, reason: 'concurrent_session' })),
    ...Array.from({ length: 3 }, () => ({ success: 0, reason: 'client_tamper:hook:http' })),
  ]);

  const { score, factors } = risk.score(key.id);
  assert.ok(score >= config.riskBanAt, `a clearly shared key only scored ${score}`);
  // And the verdict is explainable, not a black box.
  assert.ok(risk.explain({ factors }).includes('devices'));
  assert.ok(risk.explain({ factors }).includes('concurrency'));
});

test('no single signal alone can reach the ban line', () => {
  // The whole point of scoring: each factor is capped below the threshold, so
  // one weird-but-innocent pattern can never ban on its own.
  const { script, key } = mk();
  seed(key.id, script.id, Array.from({ length: 40 }, (_, i) => ({ hwid: `H${i}`, ip: '203.0.113.5' })));
  const devicesOnly = risk.score(key.id).score;
  assert.ok(devicesOnly < config.riskBanAt, `devices alone reached ${devicesOnly}`);
});

test('crossing the ban line takes the key out of service and kills its sessions', () => {
  const { script, key } = mk({ hwid_lock: 0 });
  const opened = authenticate({ scriptId: script.id, key: key.value, executor: 'synapse' });
  assert.ok(opened.success);

  seed(key.id, script.id, [
    ...['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8'].map((hwid, i) => ({ hwid, ip: `203.0.${i}.5` })),
    ...Array.from({ length: 6 }, () => ({ success: 0, reason: 'concurrent_session' })),
    ...Array.from({ length: 4 }, () => ({ success: 0, reason: 'client_tamper:hook:http' })),
  ]);

  const r = authenticate({ scriptId: script.id, key: key.value, executor: 'synapse' });
  assert.strictEqual(r.success, false);
  assert.match(r.message, /suspicious/i);
  assert.strictEqual(keys.getKeyById(key.id).status, 'banned');
  assert.strictEqual(lease.get(opened.lease), null, 'the running session survived the ban');
});

test('scoring off means nothing is scored or banned', () => {
  const { script, key } = mk({ hwid_lock: 0 });
  seed(key.id, script.id, Array.from({ length: 30 }, (_, i) => ({ hwid: `H${i}`, ip: `203.0.${i}.5` })));
  withConfig({ riskScoring: false }, () => {
    assert.ok(authenticate({ scriptId: script.id, key: key.value, executor: 'synapse' }).success);
    assert.strictEqual(keys.getKeyById(key.id).status, 'active');
  });
});

/* ---------------------------- environment pinning ---------------------------- */

test('the environment is pinned on first use and changes are counted', () => {
  const { script, key } = mk({ hwid_lock: 0 });
  authenticate({ scriptId: script.id, key: key.value, executor: 'synapse', env: ENV_A });
  assert.strictEqual(keys.getKeyById(key.id).env_fp, ENV_A);
  assert.strictEqual(keys.getKeyById(key.id).env_fp_changes, 0);

  authenticate({ scriptId: script.id, key: key.value, executor: 'synapse', env: ENV_B });
  const after = keys.getKeyById(key.id);
  assert.strictEqual(after.env_fp, ENV_B, 'the new environment should become the pin');
  assert.strictEqual(after.env_fp_changes, 1);
});

test('an environment change is a signal, never a block on its own', () => {
  const { script, key } = mk({ hwid_lock: 0 });
  authenticate({ scriptId: script.id, key: key.value, executor: 'synapse', env: ENV_A });
  // Updating an executor changes the fingerprint. The user must keep working.
  const r = authenticate({ scriptId: script.id, key: key.value, executor: 'synapse', env: ENV_B });
  assert.ok(r.success, 'a changed environment locked the user out');
});

/* ---------------------------- fuzzy device matching ---------------------------- */

test('a spoofed client id alone no longer opens the key', () => {
  const { script, key } = mk({ hwid_lock: 1 });
  assert.ok(
    authenticate({ scriptId: script.id, key: key.value, hwid: 'REAL-DEVICE', device: DEV_A, executor: 'synapse' })
      .success
  );

  // The attacker copied the HWID (there are public spoofers for it) but cannot
  // produce the token the loader wrote to the real user's disk.
  const r = authenticate({
    scriptId: script.id,
    key: key.value,
    hwid: 'REAL-DEVICE',
    device: DEV_B,
    executor: 'synapse',
  });
  assert.strictEqual(r.success, false);
  assert.match(r.message, /HWID/i);
});

test('the real user survives a client-id change, because the token still matches', () => {
  const { script, key } = mk({ hwid_lock: 1 });
  authenticate({ scriptId: script.id, key: key.value, hwid: 'CLIENT-ID-1', device: DEV_A, executor: 'synapse' });

  // Roblox reinstalled: new client id, same executor workspace.
  const r = authenticate({
    scriptId: script.id,
    key: key.value,
    hwid: 'CLIENT-ID-2',
    device: DEV_A,
    executor: 'synapse',
  });
  assert.ok(r.success, 'a reinstall locked the owner out of their own key');
});

test('requiring both identifiers is stricter, and says so', () => {
  const { script, key } = mk({ hwid_lock: 1 });
  authenticate({ scriptId: script.id, key: key.value, hwid: 'CLIENT-ID-1', device: DEV_A, executor: 'synapse' });

  withConfig({ deviceMatchRequired: 2 }, () => {
    const r = authenticate({
      scriptId: script.id,
      key: key.value,
      hwid: 'CLIENT-ID-2',
      device: DEV_A,
      executor: 'synapse',
    });
    assert.strictEqual(r.success, false, 'strict mode accepted a half match');
  });
});

test('keys bound before device tokens existed keep working', () => {
  const { script, key } = mk({ hwid_lock: 1 });
  // Bound the old way: an HWID and nothing else.
  db.prepare('UPDATE keys SET hwid = ?, device_token = NULL WHERE id = ?').run('LEGACY-DEVICE', key.id);

  assert.ok(
    authenticate({ scriptId: script.id, key: key.value, hwid: 'LEGACY-DEVICE', executor: 'synapse' }).success,
    'an existing key stopped working after the upgrade'
  );
  // …and a different device is still refused.
  assert.strictEqual(
    authenticate({ scriptId: script.id, key: key.value, hwid: 'OTHER-DEVICE', executor: 'synapse' }).success,
    false
  );
});

test('a device token is adopted the first time an already-bound key reports one', () => {
  const { script, key } = mk({ hwid_lock: 1 });
  db.prepare('UPDATE keys SET hwid = ?, device_token = NULL WHERE id = ?').run('DEVICE-X', key.id);

  authenticate({ scriptId: script.id, key: key.value, hwid: 'DEVICE-X', device: DEV_A, executor: 'synapse' });
  assert.strictEqual(keys.getKeyById(key.id).device_token, DEV_A);
});
