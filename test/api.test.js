'use strict';
// Drives the real Express app over real HTTP: loader delivery, the handshake →
// proof → auth chain, replay rejection and the tamper-report endpoint.

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // let the OS pick a free port
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef0123';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.AUTH_RATE_MAX = '100000';
process.env.TRUST_PROXY = '0'; // exposed directly: X-Forwarded-For must be ignored
process.env.DB_PATH = path.join(os.tmpdir(), `2t1auth-api-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');

const scripts = require('../src/services/scripts');
const keys = require('../src/services/keys');
const { sessionProof } = require('../src/utils/crypto');
const { server } = require('../src/index');

const HWID = 'TEST-DEVICE-0001';
const EXEC = 'synapse';

let base;
test.before(async () => {
  if (!server.listening) await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function post(pathname, body, headers = {}) {
  const res = await fetch(base + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

function mk(opts = {}) {
  const script = scripts.createScript({ name: 'API Test', source: '__R = 1', hwid_lock: 1, obfuscate: 1, ...opts });
  const [key] = keys.createKeys(script.id, { count: 1 });
  return { script, key: key.value };
}

/** handshake → build a correctly-proofed auth body. */
async function openSession(script, key, overrides = {}) {
  const hs = await post('/api/v1/handshake', { script_id: script.id });
  assert.strictEqual(hs.status, 200, hs.text);
  const fields = { script_id: script.id, key, hwid: HWID, executor: EXEC, ...overrides };
  const proof = sessionProof({
    salt: hs.body.salt,
    nonce: hs.body.nonce,
    scriptId: fields.script_id,
    key: fields.key,
    hwid: fields.hwid,
    executor: fields.executor,
  });
  return { hs: hs.body, body: { ...fields, nonce: hs.body.nonce, proof } };
}

/* ------------------------------- loader ------------------------------- */

test('the loader endpoint serves a protected, never-cached bootstrap', async () => {
  const { script } = mk();
  const res = await fetch(`${base}/loader/${script.id}.lua`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');

  const lua = await res.text();
  assert.ok(lua.length > 100);
  assert.ok(!lua.includes('/api/v1/handshake'), 'bootstrap leaks its endpoints in plaintext');

  const again = await (await fetch(`${base}/loader/${script.id}.lua`)).text();
  assert.notStrictEqual(lua, again, 'two deliveries were byte-identical');
});

test('an unknown script id yields a Lua comment, not a stack trace', async () => {
  const res = await fetch(`${base}/loader/deadbeefdeadbeef.lua`);
  assert.strictEqual(res.status, 404);
  assert.match(await res.text(), /^-- \[2t1auth\]/);
});

test('a script name cannot break out of the loader comment header', async () => {
  const { script } = mk({ name: 'evil]==] __PWNED=1 --[==[' });
  const lua = await (await fetch(`${base}/loader/${script.id}.lua`)).text();
  assert.ok(!lua.includes('__PWNED'), 'script name was injected into the delivered Lua');
});

/* ------------------------------ handshake ------------------------------ */

test('handshake issues a nonce and a salt', async () => {
  const { script } = mk();
  const res = await post('/api/v1/handshake', { script_id: script.id });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.success);
  assert.ok(res.body.nonce && res.body.salt && res.body.ttl > 0);
  assert.notStrictEqual(res.body.nonce, res.body.salt);
});

test('handshake requires a known, enabled script', async () => {
  assert.strictEqual((await post('/api/v1/handshake', {})).status, 400);
  assert.strictEqual((await post('/api/v1/handshake', { script_id: 'nope' })).status, 404);

  const { script } = mk();
  scripts.updateScript(script.id, { enabled: 0 });
  assert.strictEqual((await post('/api/v1/handshake', { script_id: script.id })).status, 503);
});

/* -------------------------------- auth -------------------------------- */

test('a complete handshake → proof → auth flow delivers a session payload', async () => {
  const { script, key } = mk();
  const { body } = await openSession(script, key);
  const res = await post('/api/v1/auth', body);

  assert.strictEqual(res.status, 200, res.text);
  assert.ok(res.body.success);
  assert.strictEqual(res.body.enc, 'session');
  assert.ok(typeof res.body.script === 'string' && res.body.script.length > 0);
});

test('auth without a handshake is refused', async () => {
  const { script, key } = mk();
  const res = await post('/api/v1/auth', { script_id: script.id, key, hwid: HWID, executor: EXEC });
  assert.strictEqual(res.status, 401);
  assert.match(res.body.message, /session/i);
});

test('auth with a valid nonce but no proof is refused', async () => {
  const { script, key } = mk();
  const { body } = await openSession(script, key);
  delete body.proof;
  const res = await post('/api/v1/auth', body);
  assert.strictEqual(res.status, 401);
  assert.match(res.body.message, /verification/i);
});

test('replaying a captured auth request is refused', async () => {
  const { script, key } = mk();
  const { body } = await openSession(script, key);
  assert.strictEqual((await post('/api/v1/auth', body)).status, 200);

  const replay = await post('/api/v1/auth', body);
  assert.strictEqual(replay.status, 401, 'a captured request was accepted twice');
});

test('editing any field of a captured request invalidates its proof', async () => {
  const { script, key } = mk({ hwid_lock: 0 });
  for (const edit of [{ hwid: 'OTHER-DEVICE' }, { executor: 'wave' }]) {
    const { body } = await openSession(script, key);
    const res = await post('/api/v1/auth', { ...body, ...edit });
    assert.strictEqual(res.status, 401, `edit ${JSON.stringify(edit)} was accepted`);
    assert.match(res.body.message, /verification/i);
  }
});

test('a nonce from one script cannot be spent on another', async () => {
  const a = mk();
  const b = mk();
  const hs = await post('/api/v1/handshake', { script_id: a.script.id });
  const proof = sessionProof({
    salt: hs.body.salt,
    nonce: hs.body.nonce,
    scriptId: b.script.id,
    key: b.key,
    hwid: HWID,
    executor: EXEC,
  });
  const res = await post('/api/v1/auth', {
    script_id: b.script.id,
    key: b.key,
    hwid: HWID,
    executor: EXEC,
    nonce: hs.body.nonce,
    proof,
  });
  assert.strictEqual(res.status, 401);
});

test('a burnt nonce cannot be retried even after a failed attempt', async () => {
  const { script, key } = mk();
  const { body } = await openSession(script, key);
  assert.strictEqual((await post('/api/v1/auth', { ...body, proof: 'wrong' })).status, 401);
  // The nonce was spent by the failed attempt — the correct proof no longer helps.
  assert.strictEqual((await post('/api/v1/auth', body)).status, 401);
});

test('auth rejects missing and oversized fields', async () => {
  const { script, key } = mk();
  assert.strictEqual((await post('/api/v1/auth', { script_id: script.id })).status, 400);
  assert.strictEqual((await post('/api/v1/auth', { key })).status, 400);

  const { body } = await openSession(script, key);
  const res = await post('/api/v1/auth', { ...body, hwid: 'A'.repeat(5000) });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.message, /malformed/i);
});

test('a forged X-Forwarded-For cannot break the session binding', async () => {
  // TRUST_PROXY=0, so req.ip stays the socket address whatever the client claims.
  const { script, key } = mk();
  const hs = await post('/api/v1/handshake', { script_id: script.id }, { 'x-forwarded-for': '1.2.3.4' });
  const proof = sessionProof({
    salt: hs.body.salt,
    nonce: hs.body.nonce,
    scriptId: script.id,
    key,
    hwid: HWID,
    executor: EXEC,
  });
  const res = await post(
    '/api/v1/auth',
    { script_id: script.id, key, hwid: HWID, executor: EXEC, nonce: hs.body.nonce, proof },
    { 'x-forwarded-for': '9.9.9.9' }
  );
  assert.strictEqual(res.status, 200, res.text);
});

test('an HWID that fails validation never binds the key', async () => {
  const { script, key } = mk({ hwid_lock: 1 });
  const { body } = await openSession(script, key, { hwid: 'unknown' });
  const res = await post('/api/v1/auth', body);
  assert.strictEqual(res.status, 400);
  assert.match(res.body.message, /HWID/i);
});

/* ------------------------------- reports ------------------------------- */

test('the report endpoint accepts a tamper signal', async () => {
  const { script, key } = mk();
  const res = await post('/api/v1/report', { script_id: script.id, key, hwid: HWID, reason: 'hook:http' });
  assert.strictEqual(res.status, 202);
  assert.ok(res.body.success);
});

test('the report endpoint validates its input', async () => {
  const { script } = mk();
  assert.strictEqual((await post('/api/v1/report', {})).status, 400);
  assert.strictEqual((await post('/api/v1/report', { script_id: 'nope', reason: 'x' })).status, 404);
  assert.strictEqual((await post('/api/v1/report', { script_id: script.id, key: 'k'.repeat(500) })).status, 400);
});

/* -------------------------------- health -------------------------------- */

test('health check reports the database is reachable', async () => {
  const res = await fetch(`${base}/health`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).status, 'ok');
});
