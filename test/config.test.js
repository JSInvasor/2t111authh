'use strict';
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef0123';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';

const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const { checkConfig } = require('../src/validateConfig');

test('healthy dev config has no errors', () => {
  const { errors } = checkConfig();
  assert.strictEqual(errors.length, 0);
});

test('production without https BASE_URL is an error', () => {
  const saved = { isProd: config.isProd, baseUrl: config.baseUrl };
  config.isProd = true;
  config.baseUrl = 'http://insecure.example';
  try {
    const { errors } = checkConfig();
    assert.ok(errors.some((e) => /https/i.test(e)));
  } finally {
    Object.assign(config, saved);
  }
});

test('production with default admin key is an error', () => {
  const saved = { isProd: config.isProd, adminApiKey: config.adminApiKey };
  config.isProd = true;
  config.adminApiKey = 'change-me-to-a-long-random-string';
  try {
    const { errors } = checkConfig();
    assert.ok(errors.some((e) => /ADMIN_API_KEY/.test(e)));
  } finally {
    Object.assign(config, saved);
  }
});
