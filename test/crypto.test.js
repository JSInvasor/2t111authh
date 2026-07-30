'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { generateKey, generateScriptId, safeEqual } = require('../src/utils/crypto');

test('generateKey has prefix + 4 segments', () => {
  assert.match(generateKey('2t1'), /^2t1_[A-Z0-9]{8}-[A-Z0-9]{8}-[A-Z0-9]{8}-[A-Z0-9]{8}$/);
});

test('generateKey without prefix', () => {
  assert.match(generateKey(''), /^[A-Z0-9]{8}-[A-Z0-9]{8}-[A-Z0-9]{8}-[A-Z0-9]{8}$/);
});

test('keys are unique across a large sample', () => {
  const set = new Set(Array.from({ length: 2000 }, () => generateKey('x')));
  assert.strictEqual(set.size, 2000);
});

test('generateScriptId is 16 hex chars', () => {
  assert.match(generateScriptId(), /^[0-9a-f]{16}$/);
});

test('safeEqual is correct', () => {
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('abc', 'abcd')); // different length
});
