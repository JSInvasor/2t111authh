'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { hashPassword, verifyPassword } = require('../src/utils/password');

test('hash then verify succeeds', () => {
  const h = hashPassword('s3cret!');
  assert.ok(h.startsWith('scrypt$'));
  assert.ok(verifyPassword('s3cret!', h));
});

test('wrong password fails', () => {
  const h = hashPassword('correct-horse');
  assert.ok(!verifyPassword('battery-staple', h));
});

test('malformed stored hash fails safely', () => {
  assert.ok(!verifyPassword('x', 'garbage'));
  assert.ok(!verifyPassword('x', null));
  assert.ok(!verifyPassword('x', 'scrypt$only-salt'));
});

test('two hashes of same password differ (random salt)', () => {
  assert.notStrictEqual(hashPassword('same'), hashPassword('same'));
});
