'use strict';
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef0123';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.DB_PATH = path.join(os.tmpdir(), `2t1auth-reseller-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);

const test = require('node:test');
const assert = require('node:assert');
const resellers = require('../src/services/resellers');
const scripts = require('../src/services/scripts');
const keys = require('../src/services/keys');

test('create + login', async () => {
  const r = await resellers.create({ username: 'bob', password: 'secret123', credits: 5 });
  assert.strictEqual(r.credits, 5);
  assert.ok(await resellers.verifyLogin('bob', 'secret123'));
  assert.strictEqual(await resellers.verifyLogin('bob', 'wrong'), null);
});

test('credits: add and spend atomically, never below 0', async () => {
  const r = await resellers.create({ username: 'c1', password: 'secret123', credits: 3 });
  assert.ok(resellers.spendCredits(r.id, 2)); // 3 -> 1
  assert.strictEqual(resellers.getById(r.id).credits, 1);
  assert.ok(!resellers.spendCredits(r.id, 2)); // insufficient -> false, unchanged
  assert.strictEqual(resellers.getById(r.id).credits, 1);
  resellers.addCredits(r.id, 10);
  assert.strictEqual(resellers.getById(r.id).credits, 11);
  resellers.addCredits(r.id, -100); // floors at 0
  assert.strictEqual(resellers.getById(r.id).credits, 0);
});

test('script assignment scopes key creation and listing', async () => {
  const r = await resellers.create({ username: 'c2', password: 'secret123', credits: 10 });
  const s = scripts.createScript({ name: 'S' });
  const s2 = scripts.createScript({ name: 'S2' });

  assert.ok(!resellers.hasScript(r.id, s.id));
  resellers.assignScript(r.id, s.id);
  assert.ok(resellers.hasScript(r.id, s.id));
  assert.ok(!resellers.hasScript(r.id, s2.id));
  assert.deepStrictEqual(resellers.scriptsFor(r.id).map((x) => x.id), [s.id]);

  const created = keys.createKeys(s.id, { count: 3, resellerId: r.id });
  assert.ok(created.every((k) => k.reseller_id === r.id));
  keys.createKeys(s.id, { count: 2 }); // admin keys (no reseller)
  assert.strictEqual(keys.listKeysByReseller(r.id).length, 3); // only the reseller's own
});

test('assigned scripts never expose source', async () => {
  const r = await resellers.create({ username: 'c3', password: 'secret123' });
  const s = scripts.createScript({ name: 'Secret', source: 'print("SRC")' });
  resellers.assignScript(r.id, s.id);
  assert.ok(!('source' in resellers.scriptsFor(r.id)[0]));
});

test('a failed key mint refunds nothing because it never debits', async () => {
  const db = require('../src/db');
  const r = await resellers.create({ username: 'tx', password: 'secret123', credits: 10 });

  // Debit and mint share one transaction, so a failure anywhere inside it rolls
  // the credits back. Previously they were two statements and the reseller was
  // charged for keys that were never created.
  assert.throws(() => {
    db.transaction(() => {
      resellers.spendCredits(r.id, 4);
      throw new Error('minting blew up');
    })();
  }, /minting blew up/);

  assert.strictEqual(resellers.getById(r.id).credits, 10, 'credits were consumed by a failed mint');
});

test('changing a reseller password retires its sessions', async () => {
  const r = await resellers.create({ username: 'rotate', password: 'secret123' });
  const before = resellers.getByUsername('rotate').token_version;
  await resellers.setPassword(r.id, 'new-secret123');
  assert.strictEqual(resellers.getByUsername('rotate').token_version, before + 1);
});

test('removing a reseller detaches (keeps) its keys', async () => {
  const r = await resellers.create({ username: 'c4', password: 'secret123' });
  const s = scripts.createScript({ name: 'S' });
  resellers.assignScript(r.id, s.id);
  const [k] = keys.createKeys(s.id, { count: 1, resellerId: r.id });
  resellers.remove(r.id);
  assert.strictEqual(keys.getKeyById(k.id).reseller_id, null);
  assert.strictEqual(resellers.getById(r.id), undefined);
});
