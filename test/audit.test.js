'use strict';
// The audit trail. What matters is that it is complete (every path that can
// touch a key records it, including the Discord bot, which calls the services
// directly rather than going through a route) and that it cannot be rewritten
// by the people it exists to hold to account.

const path = require('node:path');
const os = require('node:os');
const nodeCrypto = require('node:crypto');
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef0123';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.DB_PATH = path.join(
  os.tmpdir(),
  `2t1auth-audit-${process.pid}-${nodeCrypto.randomBytes(4).toString('hex')}.db`
);

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const scripts = require('../src/services/scripts');
const keys = require('../src/services/keys');
const resellers = require('../src/services/resellers');
const audit = require('../src/services/audit');

const ADMIN = { type: 'admin', id: null, name: 'root', ip: '203.0.113.1' };
const DEALER = { type: 'reseller', id: '7', name: 'bob', ip: '198.51.100.4' };

function mk() {
  const script = scripts.createScript({ name: 'Audit', source: 'x' });
  const [key] = keys.createKeys(script.id, { count: 1, actor: ADMIN });
  return { script, key };
}

const entriesFor = (id) => audit.list({ targetType: 'key', targetId: id });

test('a ban records who did it, and to what', () => {
  const { key } = mk();
  keys.updateKey(key.id, { status: 'banned' }, { actor: DEALER });

  const [entry] = entriesFor(key.id);
  assert.strictEqual(entry.action, 'key.banned');
  assert.strictEqual(entry.actor_type, 'reseller');
  assert.strictEqual(entry.actor_name, 'bob');
  assert.strictEqual(entry.actor_id, '7');
  assert.strictEqual(entry.ip, '198.51.100.4');
  assert.deepStrictEqual(JSON.parse(entry.detail).changed, { status: 'banned' });
});

test('an HWID reset records what it was reset from', () => {
  const { key } = mk();
  keys.updateKey(key.id, { hwid: 'DEVICE-1' }, { actor: ADMIN });
  keys.resetHwid(key.id, { actor: DEALER });

  const entry = entriesFor(key.id).find((e) => e.action === 'key.reset_hwid');
  assert.ok(entry, 'the reset went unrecorded');
  assert.strictEqual(JSON.parse(entry.detail).from_hwid, 'DEVICE-1');
});

test('a deleted key leaves behind what it was', () => {
  const { key } = mk();
  const value = key.value;
  keys.deleteKey(key.id, { actor: DEALER });

  // The row is gone, so this entry is the only thing that can answer
  // "what happened to the key I bought".
  assert.strictEqual(keys.getKeyById(key.id), undefined);
  const entry = entriesFor(key.id).find((e) => e.action === 'key.delete');
  assert.ok(entry);
  assert.strictEqual(JSON.parse(entry.detail).value, value);
});

test('a self-service HWID reset is attributed to the Discord user who ran it', () => {
  const script = scripts.createScript({ name: 'Bot', hwid_reset_cooldown: 0, hwid_reset_limit: 5 });
  const [key] = keys.createKeys(script.id, { count: 1 });
  keys.updateKey(key.id, { hwid: 'DEVICE-9' });

  const actor = audit.actorFromDiscord({ id: '999000111', tag: 'someone#1234' });
  const res = keys.userResetHwid(keys.getKeyById(key.id), script, { actor });
  assert.ok(res.ok, JSON.stringify(res));

  const entry = entriesFor(key.id).find((e) => e.action === 'key.reset_hwid');
  assert.strictEqual(entry.actor_type, 'bot');
  assert.strictEqual(entry.actor_id, '999000111');
  assert.strictEqual(entry.actor_name, 'someone#1234');
});

test('credit movements are recorded with the balance either side', async () => {
  const r = await resellers.create({ username: 'audited', password: 'secret123', credits: 5, actor: ADMIN });
  resellers.addCredits(r.id, 20, { actor: ADMIN });

  const entry = audit.list({ targetType: 'reseller', targetId: r.id }).find((e) => e.action === 'reseller.credits');
  assert.deepStrictEqual(JSON.parse(entry.detail), { amount: 20, from: 5, to: 25 });
});

test('everything one reseller has done can be pulled up at once', () => {
  const { key: a } = mk();
  const { key: b } = mk();
  keys.updateKey(a.id, { status: 'banned' }, { actor: DEALER });
  keys.updateKey(b.id, { status: 'banned' }, { actor: DEALER });
  keys.resetHwid(b.id, { actor: DEALER });

  const theirs = audit.byActor('reseller', '7');
  assert.ok(theirs.length >= 3, 'a reseller going bad should be visible in one query');
  assert.ok(theirs.every((e) => e.actor_name === 'bob'));
});

test('a mutation with no named actor is recorded as system, not dropped', () => {
  const { key } = mk();
  keys.updateKey(key.id, { note: 'changed by something' });

  const entry = entriesFor(key.id).find((e) => e.action === 'key.update');
  assert.strictEqual(entry.actor_type, 'system');
});

/* ------------------------------ append-only ------------------------------ */

test('audit rows cannot be edited or deleted, even with direct SQL', () => {
  const { key } = mk();
  keys.updateKey(key.id, { status: 'banned' }, { actor: DEALER });
  const [entry] = entriesFor(key.id);

  // A log the accused can rewrite answers nothing, so this is enforced by the
  // database rather than by everyone remembering not to.
  assert.throws(
    () => db.prepare('UPDATE audit_log SET actor_name = ? WHERE id = ?').run('someone else', entry.id),
    /append-only/
  );
  assert.throws(() => db.prepare('DELETE FROM audit_log WHERE id = ?').run(entry.id), /append-only/);

  const [still] = entriesFor(key.id);
  assert.strictEqual(still.actor_name, 'bob');
});

test('a failed audit write never takes down the action it describes', () => {
  const { key } = mk();
  const original = console.error;
  console.error = () => {};
  try {
    // Force the insert to blow up mid-action.
    const broken = { get type() {
      throw new Error('boom');
    } };
    assert.doesNotThrow(() => audit.record({ actor: broken, action: 'key.ban' }));
    // …and the real operation still goes through.
    assert.strictEqual(keys.updateKey(key.id, { status: 'paused' }, { actor: ADMIN }).status, 'paused');
  } finally {
    console.error = original;
  }
});
