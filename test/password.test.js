'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { hashPassword, verifyPassword } = require('../src/utils/password');

test('hash then verify succeeds', async () => {
  const h = await hashPassword('s3cret!');
  assert.ok(h.startsWith('scrypt$'));
  assert.ok(await verifyPassword('s3cret!', h));
});

test('wrong password fails', async () => {
  const h = await hashPassword('correct-horse');
  assert.ok(!(await verifyPassword('battery-staple', h)));
});

test('malformed stored hash fails safely', async () => {
  assert.ok(!(await verifyPassword('x', 'garbage')));
  assert.ok(!(await verifyPassword('x', null)));
  assert.ok(!(await verifyPassword('x', 'scrypt$only-salt')));
});

test('two hashes of same password differ (random salt)', async () => {
  assert.notStrictEqual(await hashPassword('same'), await hashPassword('same'));
});

test('hashing never blocks the event loop', async () => {
  // scrypt is memory-hard (~50ms a call). Sync, that is 50ms the process spends
  // doing nothing else; async, the loop keeps turning while it runs.
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  await hashPassword('some-password');
  clearInterval(timer);
  assert.ok(ticks > 0, 'the event loop was blocked for the whole hash');
});
