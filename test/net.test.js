'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { netPrefix, sameNetwork, normalise } = require('../src/utils/net');

test('IPv4 collapses to its /24', () => {
  assert.strictEqual(netPrefix('203.0.113.7'), '203.0.113');
  assert.ok(sameNetwork('203.0.113.7', '203.0.113.200'));
  assert.ok(!sameNetwork('203.0.113.7', '203.0.114.7'));
});

test('IPv6 collapses to its /64, however it is spelled', () => {
  assert.ok(sameNetwork('2001:db8:1:2::1', '2001:db8:1:2:aaaa:bbbb:cccc:dddd'));
  // The same network written with and without the "::" run must compare equal.
  assert.ok(sameNetwork('2001:db8::1', '2001:0db8:0:0:1:2:3:4'));
  assert.ok(!sameNetwork('2001:db8:1:2::1', '2001:db8:1:3::1'));
});

test('IPv4-mapped IPv6 is treated as the IPv4 address it is', () => {
  assert.strictEqual(normalise('::ffff:203.0.113.7'), '203.0.113.7');
  assert.ok(sameNetwork('::ffff:203.0.113.7', '203.0.113.9'));
});

test('a missing address never matches anything', () => {
  assert.ok(!sameNetwork(null, null));
  assert.ok(!sameNetwork('', ''));
  assert.ok(!sameNetwork(undefined, '203.0.113.1'));
});

test('a handshake still cannot be relayed to a different network', () => {
  // The point of the binding: same subnet is fine, somewhere else entirely is not.
  assert.ok(!sameNetwork('203.0.113.7', '198.51.100.7'));
  assert.ok(!sameNetwork('203.0.113.7', '2001:db8::1'));
});
