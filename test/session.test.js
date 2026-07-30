'use strict';
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef0123';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';

const test = require('node:test');
const assert = require('node:assert');
const { createToken, verifyToken } = require('../src/utils/session');

test('valid token round-trips', () => {
  const payload = verifyToken(createToken('admin'));
  assert.strictEqual(payload.u, 'admin');
});

test('tampered signature is rejected', () => {
  const tok = createToken('admin');
  const last = tok.slice(-1);
  const tampered = tok.slice(0, -1) + (last === 'A' ? 'B' : 'A');
  assert.strictEqual(verifyToken(tampered), null);
});

test('expired token is rejected', () => {
  assert.strictEqual(verifyToken(createToken('admin', { maxAgeMs: -1000 })), null);
});

test('role and reseller id round-trip', () => {
  const p = verifyToken(createToken('bob', { role: 'reseller', rid: 7 }));
  assert.strictEqual(p.role, 'reseller');
  assert.strictEqual(p.rid, 7);
});

test('garbage tokens are rejected', () => {
  assert.strictEqual(verifyToken('not-a-token'), null);
  assert.strictEqual(verifyToken(''), null);
  assert.strictEqual(verifyToken(null), null);
});
