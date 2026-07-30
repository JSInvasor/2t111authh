'use strict';
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef0123';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.DB_PATH = path.join(os.tmpdir(), `2t1auth-keys-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);

const test = require('node:test');
const assert = require('node:assert');
const scripts = require('../src/services/scripts');
const keys = require('../src/services/keys');

test('createKeys links discord id and is findable', () => {
  const s = scripts.createScript({ name: 'K' });
  const [k] = keys.createKeys(s.id, { count: 1, discordId: 'd1', note: 'n' });
  assert.strictEqual(keys.getKeyByDiscord(s.id, 'd1').value, k.value);
});

test('bulk create respects count', () => {
  const s = scripts.createScript({ name: 'B' });
  assert.strictEqual(keys.createKeys(s.id, { count: 25 }).length, 25);
  assert.strictEqual(keys.listKeys(s.id, { limit: 1000 }).length, 25);
});

test('userResetHwid: no hwid -> no_hwid, then ok, then cooldown', () => {
  const s = scripts.createScript({ name: 'C', hwid_reset_limit: 5, hwid_reset_cooldown: 3600 });
  const [k] = keys.createKeys(s.id, { count: 1 });

  assert.strictEqual(keys.userResetHwid(keys.getKeyById(k.id), s).reason, 'no_hwid');

  keys.updateKey(k.id, { hwid: 'H1' });
  assert.ok(keys.userResetHwid(keys.getKeyById(k.id), s).ok);

  keys.updateKey(k.id, { hwid: 'H2' });
  assert.strictEqual(keys.userResetHwid(keys.getKeyById(k.id), s).reason, 'cooldown');
});

test('userResetHwid: reset limit is enforced', () => {
  const s = scripts.createScript({ name: 'L', hwid_reset_limit: 1, hwid_reset_cooldown: 0 });
  const [k] = keys.createKeys(s.id, { count: 1 });

  keys.updateKey(k.id, { hwid: 'A' });
  assert.ok(keys.userResetHwid(keys.getKeyById(k.id), s).ok); // count -> 1

  keys.updateKey(k.id, { hwid: 'B' });
  assert.strictEqual(keys.userResetHwid(keys.getKeyById(k.id), s).reason, 'limit');
});
