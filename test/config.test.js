'use strict';
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef0123';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';

const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const { int, bool, list } = require('../src/config')._parse;
const { checkConfig } = require('../src/validateConfig');

test('healthy dev config has no errors', () => {
  const { errors } = checkConfig();
  assert.strictEqual(errors.length, 0);
});

test('a malformed numeric env falls back instead of poisoning everything', () => {
  // The bug this guards: parseInt('twenty') is NaN, `Date.now() + NaN` is NaN,
  // and `NaN < Date.now()` is false — so nonces would never expire and the
  // store would grow forever, silently, from one typo in .env.
  for (const junk of ['twenty', '', undefined, null, 'NaN', ' ', 'e5']) {
    assert.strictEqual(int(junk, 20000), 20000, JSON.stringify(junk));
  }
  assert.strictEqual(int('45000', 20000), 45000);
  // A leading number still wins — parseInt's prefix rule is unchanged, only the
  // no-number-at-all case is repaired.
  assert.strictEqual(int('60s', 20000), 60);
});

test('a multi-worker deployment is refused, not silently half-broken', () => {
  // Handshakes and leases live in this process's memory, so a second worker
  // makes auth fail for whoever's handshake landed on the other one — an
  // intermittent failure that looks like anything but the deploy topology.
  const saved = { ...process.env };
  try {
    process.env.NODE_APP_INSTANCE = '2';
    assert.match(checkConfig().errors.join(' '), /multi-process|instance 2/i);
    delete process.env.NODE_APP_INSTANCE;

    process.env.WEB_CONCURRENCY = '4';
    assert.match(checkConfig().errors.join(' '), /workers/i);
    delete process.env.WEB_CONCURRENCY;

    // Worker 0 of one, or nothing set at all, is the ordinary single-process case.
    process.env.NODE_APP_INSTANCE = '0';
    process.env.WEB_CONCURRENCY = '1';
    assert.strictEqual(checkConfig().errors.length, 0);
  } finally {
    for (const k of ['NODE_APP_INSTANCE', 'WEB_CONCURRENCY', 'pm_id', 'instances']) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('numeric envs are clamped to their sane range', () => {
  assert.strictEqual(int('-5', 10, { min: 0 }), 0);
  assert.strictEqual(int('999999', 10, { min: 0, max: 100 }), 100);
});

test('the shipped anti-tamper defaults are all live values, never NaN', () => {
  for (const k of [
    'nonceTtlMs',
    'nonceMax',
    'nonceMaxPerIp',
    'keyShareWindowMs',
    'keyShareMaxHwids',
    'keyShareMaxIps',
    'keyRateMax',
    'keyRateWindowMs',
    'hwidMaxLength',
    'authRateMax',
    'trustProxy',
  ]) {
    assert.ok(Number.isFinite(config[k]), `${k} is ${config[k]}`);
  }
  assert.ok(config.nonceTtlMs > 0);
  assert.ok(config.nonceMax >= 100);
});

test('boolean envs treat the usual off-switches as off', () => {
  for (const off of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) assert.strictEqual(bool(off, true), false, off);
  for (const on of ['1', 'true', 'yes', 'anything']) assert.strictEqual(bool(on, false), true, on);
  assert.strictEqual(bool(undefined, true), true);
  assert.strictEqual(bool('', false), false);
});

test('list envs are trimmed, lowercased and de-duplicated', () => {
  assert.deepStrictEqual(list(' Synapse , SCRIPTWARE ,synapse, '), ['synapse', 'scriptware']);
  assert.deepStrictEqual(list(''), []);
  assert.deepStrictEqual(list(undefined), []);
});

test('anti-tamper is on by default and says so when it is not', () => {
  assert.strictEqual(config.antiTamper, true);
  assert.strictEqual(config.requireProof, true);
  assert.strictEqual(config.sessionEncryption, true);

  const saved = config.antiTamper;
  config.antiTamper = false;
  try {
    assert.ok(checkConfig().warnings.some((w) => /ANTI_TAMPER=0/.test(w)));
  } finally {
    config.antiTamper = saved;
  }
});

test('production refuses to boot with anti-tamper disabled', () => {
  const saved = { isProd: config.isProd, antiTamper: config.antiTamper };
  config.isProd = true;
  config.antiTamper = false;
  try {
    assert.ok(checkConfig().errors.some((e) => /ANTI_TAMPER=0/.test(e)));
  } finally {
    Object.assign(config, saved);
  }
});

test('production without https BASE_URL is an error', () => {
  const saved = { isProd: config.isProd, baseUrl: config.baseUrl };
  config.isProd = true;
  config.baseUrl = 'http://insecure.example';
  try {
    const { errors } = checkConfig();
    assert.ok(errors.some((e) => /https/i.test(e)));
  } finally {
    Object.assign(config, saved);
  }
});

test('production with default admin key is an error', () => {
  const saved = { isProd: config.isProd, adminApiKey: config.adminApiKey };
  config.isProd = true;
  config.adminApiKey = 'change-me-to-a-long-random-string';
  try {
    const { errors } = checkConfig();
    assert.ok(errors.some((e) => /ADMIN_API_KEY/.test(e)));
  } finally {
    Object.assign(config, saved);
  }
});
