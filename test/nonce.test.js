'use strict';
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef0123';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.NONCE_MAX = '50';
process.env.NONCE_MAX_PER_IP = '3';

const test = require('node:test');
const assert = require('node:assert');
const nonce = require('../src/services/nonce');
const config = require('../src/config');

const IP = '203.0.113.7';

test.beforeEach(() => nonce.reset());

test('handshake issues a nonce and a salt', () => {
  const s = nonce.issue('s1', { ip: IP });
  assert.match(s.nonce, /^[A-Za-z0-9_-]{20,}$/);
  assert.match(s.salt, /^[A-Za-z0-9_-]{20,}$/);
  assert.notStrictEqual(s.nonce, s.salt);
  assert.strictEqual(s.ttl, config.nonceTtlMs);
});

test('two handshakes never collide', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(nonce.issue('s1', { ip: `10.0.0.${i % 250}` }).nonce);
  assert.strictEqual(seen.size, 200);
});

test('nonce is single-use', () => {
  const { nonce: n } = nonce.issue('s1', { ip: IP });
  assert.ok(nonce.consume(n, { scriptId: 's1', ip: IP }).ok);
  assert.strictEqual(nonce.consume(n, { scriptId: 's1', ip: IP }).reason, 'unknown_nonce');
});

test('consuming returns the salt the handshake issued', () => {
  const s = nonce.issue('s1', { ip: IP });
  assert.strictEqual(nonce.consume(s.nonce, { scriptId: 's1', ip: IP }).salt, s.salt);
});

test('nonce is bound to its script', () => {
  const { nonce: n } = nonce.issue('s1', { ip: IP });
  assert.strictEqual(nonce.consume(n, { scriptId: 's2', ip: IP }).reason, 'nonce_script_mismatch');
});

test('nonce is bound to the IP that requested it', () => {
  const { nonce: n } = nonce.issue('s1', { ip: IP });
  assert.strictEqual(nonce.consume(n, { scriptId: 's1', ip: '198.51.100.9' }).reason, 'nonce_ip_mismatch');
});

test('a failed consume still burns the nonce', () => {
  const { nonce: n } = nonce.issue('s1', { ip: IP });
  assert.ok(!nonce.consume(n, { scriptId: 's2', ip: IP }).ok);
  // no retry with the right script id — one shot, valid or not
  assert.strictEqual(nonce.consume(n, { scriptId: 's1', ip: IP }).reason, 'unknown_nonce');
});

test('expired nonce is rejected', () => {
  const { nonce: n } = nonce.issue('s1', { ip: IP });
  nonce._store.get(n).expires = Date.now() - 1; // force-expire
  assert.strictEqual(nonce.consume(n, { scriptId: 's1', ip: IP }).reason, 'expired_nonce');
});

test('unknown nonce is rejected', () => {
  assert.strictEqual(nonce.consume('does-not-exist', { scriptId: 's1', ip: IP }).reason, 'unknown_nonce');
});

test('sweep drops expired entries', () => {
  const a = nonce.issue('s1', { ip: IP });
  const b = nonce.issue('s1', { ip: IP });
  nonce._store.get(a.nonce).expires = Date.now() - 1;
  nonce.sweep();
  assert.strictEqual(nonce.stats().live, 1);
  assert.ok(nonce.consume(b.nonce, { scriptId: 's1', ip: IP }).ok);
});

test('one IP cannot hold more than its share of live handshakes', () => {
  const issued = [];
  for (let i = 0; i < 10; i++) issued.push(nonce.issue('s1', { ip: IP }).nonce);
  assert.strictEqual(nonce.stats().live, config.nonceMaxPerIp);
  // the newest survive; the oldest were retired to make room
  assert.ok(nonce.consume(issued[9], { scriptId: 's1', ip: IP }).ok);
  assert.strictEqual(nonce.consume(issued[0], { scriptId: 's1', ip: IP }).reason, 'unknown_nonce');
});

test('the store is globally capped (flood cannot exhaust memory)', () => {
  for (let i = 0; i < 500; i++) nonce.issue('s1', { ip: `10.1.${Math.floor(i / 250)}.${i % 250}` });
  assert.ok(nonce.stats().live <= config.nonceMax, `live=${nonce.stats().live}`);
});

test('per-IP accounting does not leak once entries are gone', () => {
  const s = nonce.issue('s1', { ip: IP });
  nonce.consume(s.nonce, { scriptId: 's1', ip: IP });
  assert.strictEqual(nonce.stats().ips, 0);
});
