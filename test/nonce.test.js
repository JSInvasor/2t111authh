'use strict';
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef0123';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';

const test = require('node:test');
const assert = require('node:assert');
const nonce = require('../src/services/nonce');

test('nonce is single-use', () => {
  const n = nonce.issue('s1');
  assert.ok(nonce.consume(n, 's1'));
  assert.ok(!nonce.consume(n, 's1')); // already consumed
});

test('nonce is bound to its script', () => {
  const n = nonce.issue('s1');
  assert.ok(!nonce.consume(n, 's2'));
});

test('expired nonce is rejected', () => {
  const n = nonce.issue('s1');
  nonce._store.get(n).expires = Date.now() - 1; // force-expire
  assert.ok(!nonce.consume(n, 's1'));
});

test('unknown nonce is rejected', () => {
  assert.ok(!nonce.consume('does-not-exist', 's1'));
});
