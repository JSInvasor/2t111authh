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
const { keyHash, serverProof, clientProof, reportProof, responseProof } = require('../src/utils/crypto');
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

/** Tamper reasons logged against a script, in insertion order. */
function reasonsFor(scriptId) {
  return require('../src/db')
    .prepare("SELECT reason FROM executions WHERE script_id = ? AND reason LIKE 'client_tamper:%' ORDER BY id")
    .all(scriptId)
    .map((r) => r.reason);
}

/** handshake → verify the server's proof → build a correctly-proofed auth body. */
async function openSession(script, key, overrides = {}) {
  const kh = keyHash(key);
  const hs = await post('/api/v1/handshake', { script_id: script.id, kh });
  assert.strictEqual(hs.status, 200, hs.text);
  assert.strictEqual(
    hs.body.server_proof,
    serverProof({ key, nonce: hs.body.nonce, salt: hs.body.salt, scriptId: script.id }),
    'server failed to prove it holds the key'
  );
  const fields = { script_id: script.id, kh, hwid: HWID, executor: EXEC, ...overrides };
  const proof = clientProof({
    key,
    nonce: hs.body.nonce,
    scriptId: fields.script_id,
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

test('handshake issues a nonce, a salt and the server proof', async () => {
  const { script, key } = mk();
  const res = await post('/api/v1/handshake', { script_id: script.id, kh: keyHash(key) });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.success);
  assert.ok(res.body.nonce && res.body.salt && res.body.ttl > 0);
  assert.notStrictEqual(res.body.nonce, res.body.salt);
  assert.strictEqual(
    res.body.server_proof,
    serverProof({ key, nonce: res.body.nonce, salt: res.body.salt, scriptId: script.id })
  );
});

test('handshake requires a known, enabled script and a well-formed kh', async () => {
  const { key } = mk();
  const kh = keyHash(key);
  assert.strictEqual((await post('/api/v1/handshake', {})).status, 400);
  assert.strictEqual((await post('/api/v1/handshake', { script_id: 'nope', kh })).status, 404);

  const { script } = mk();
  assert.strictEqual((await post('/api/v1/handshake', { script_id: script.id })).status, 400);
  assert.strictEqual((await post('/api/v1/handshake', { script_id: script.id, kh: 'nothex' })).status, 400);

  scripts.updateScript(script.id, { enabled: 0 });
  assert.strictEqual((await post('/api/v1/handshake', { script_id: script.id, kh })).status, 503);
});

test('an unknown key gets a decoy proof, so the handshake is not a key oracle', async () => {
  const { script, key } = mk();
  const real = await post('/api/v1/handshake', { script_id: script.id, kh: keyHash(key) });
  const fake = await post('/api/v1/handshake', { script_id: script.id, kh: keyHash('2t1_NO-SUCH-KEY') });

  assert.strictEqual(real.status, fake.status);
  assert.deepStrictEqual(Object.keys(real.body).sort(), Object.keys(fake.body).sort());
  assert.strictEqual(fake.body.server_proof.length, real.body.server_proof.length);
  // …and the decoy is not something a client could ever verify.
  assert.notStrictEqual(
    fake.body.server_proof,
    serverProof({ key: '2t1_NO-SUCH-KEY', nonce: fake.body.nonce, salt: fake.body.salt, scriptId: script.id })
  );
});

/* -------------------------------- auth -------------------------------- */

test('a complete handshake → proof → auth flow delivers a signed session payload', async () => {
  const { script, key } = mk();
  const { body } = await openSession(script, key);
  const res = await post('/api/v1/auth', body);

  assert.strictEqual(res.status, 200, res.text);
  assert.ok(res.body.success);
  assert.strictEqual(res.body.enc, 'session');
  assert.ok(typeof res.body.script === 'string' && res.body.script.length > 0);
  assert.strictEqual(
    res.body.resp_proof,
    responseProof({ key, nonce: body.nonce, enc: 'session', script: res.body.script }),
    'the response was not signed under the key'
  );
});

test('the auth request never carries the key itself', async () => {
  const { script, key } = mk();
  const { body } = await openSession(script, key);
  assert.ok(!('key' in body));
  assert.ok(!JSON.stringify(body).includes(key), 'the key leaked into the auth request');
});

test('auth without a handshake is refused', async () => {
  const { script, key } = mk();
  const res = await post('/api/v1/auth', { script_id: script.id, kh: keyHash(key), hwid: HWID, executor: EXEC });
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
  const hs = await post('/api/v1/handshake', { script_id: a.script.id, kh: keyHash(a.key) });
  const proof = clientProof({
    key: b.key,
    nonce: hs.body.nonce,
    scriptId: b.script.id,
    hwid: HWID,
    executor: EXEC,
  });
  const res = await post('/api/v1/auth', {
    script_id: b.script.id,
    kh: keyHash(b.key),
    hwid: HWID,
    executor: EXEC,
    nonce: hs.body.nonce,
    proof,
  });
  assert.strictEqual(res.status, 401);
});

test('a handshake opened for one key cannot be spent for another', async () => {
  const { script, key } = mk();
  const [other] = keys.createKeys(script.id, { count: 1 });
  const hs = await post('/api/v1/handshake', { script_id: script.id, kh: keyHash(key) });
  const res = await post('/api/v1/auth', {
    script_id: script.id,
    kh: keyHash(other.value),
    hwid: HWID,
    executor: EXEC,
    nonce: hs.body.nonce,
    proof: clientProof({ key: other.value, nonce: hs.body.nonce, scriptId: script.id, hwid: HWID, executor: EXEC }),
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
  assert.strictEqual((await post('/api/v1/auth', { kh: keyHash(key) })).status, 400);
  assert.strictEqual((await post('/api/v1/auth', { script_id: script.id, kh: 'nothex' })).status, 400);

  const { body } = await openSession(script, key);
  const res = await post('/api/v1/auth', { ...body, hwid: 'A'.repeat(5000) });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.message, /malformed/i);
});

test('a forged X-Forwarded-For cannot break the session binding', async () => {
  // TRUST_PROXY=0, so req.ip stays the socket address whatever the client claims.
  const { script, key } = mk();
  const kh = keyHash(key);
  const hs = await post('/api/v1/handshake', { script_id: script.id, kh }, { 'x-forwarded-for': '1.2.3.4' });
  const proof = clientProof({ key, nonce: hs.body.nonce, scriptId: script.id, hwid: HWID, executor: EXEC });
  const res = await post(
    '/api/v1/auth',
    { script_id: script.id, kh, hwid: HWID, executor: EXEC, nonce: hs.body.nonce, proof },
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

/** Open a handshake and build a correctly-proofed tamper report. */
async function openReport(script, key, reason, overrides = {}) {
  const kh = keyHash(key);
  const hs = await post('/api/v1/handshake', { script_id: script.id, kh });
  return {
    script_id: script.id,
    kh,
    hwid: HWID,
    executor: EXEC,
    reason,
    nonce: hs.body.nonce,
    proof: reportProof({ key, nonce: hs.body.nonce, scriptId: script.id, reason }),
    ...overrides,
  };
}

test('the report endpoint accepts a proofed tamper signal', async () => {
  const { script, key } = mk();
  const res = await post('/api/v1/report', await openReport(script, key, 'hook:http'));
  assert.strictEqual(res.status, 202);
  assert.ok(res.body.success);
  assert.ok(reasonsFor(script.id).includes('client_tamper:hook:http'));
});

test('the report endpoint validates its input', async () => {
  const { script, key } = mk();
  assert.strictEqual((await post('/api/v1/report', {})).status, 400);
  assert.strictEqual((await post('/api/v1/report', { script_id: script.id })).status, 400);
  assert.strictEqual(
    (await post('/api/v1/report', { script_id: script.id, kh: keyHash(key), reason: 'r'.repeat(500) })).status,
    400
  );
});

test('an unproofed report is silently dropped, so it cannot be used to ban a key', async () => {
  const { script, key } = mk();
  // Everything an attacker who merely learned the key value could assemble.
  const forged = await openReport(script, key, 'hook:http', { proof: 'wrong' });
  const res = await post('/api/v1/report', forged);

  // Answered like a success, so the attacker cannot tell it was rejected…
  assert.strictEqual(res.status, 202);
  // …but nothing was recorded, so it can never count toward TAMPER_REPORT_BAN.
  assert.deepStrictEqual(reasonsFor(script.id), []);
});

test('a report replayed on a spent nonce is dropped', async () => {
  const { script, key } = mk();
  const report = await openReport(script, key, 'hook:http');
  assert.strictEqual((await post('/api/v1/report', report)).status, 202);
  assert.strictEqual(reasonsFor(script.id).length, 1);

  await post('/api/v1/report', report);
  assert.strictEqual(reasonsFor(script.id).length, 1, 'a replayed report was counted twice');
});

/* ------------------------------- sessions ------------------------------- */

test('changing a password signs out the sessions that predate it', async () => {
  const admins = require('../src/services/admins');
  await admins.upsertAdmin('rotator', 'first-password');

  const login = await post('/dashboard/api/login', { username: 'rotator', password: 'first-password' });
  assert.strictEqual(login.status, 200, login.text);
  const cookie = login.headers.getSetCookie().join('; ');

  const withCookie = () => fetch(`${base}/api/v1/overview`, { headers: { cookie } });
  assert.strictEqual((await withCookie()).status, 200, 'a fresh session should work');

  // The cookie is untouched and its signature is still valid — only the
  // account's token_version moved.
  await admins.upsertAdmin('rotator', 'second-password');
  assert.strictEqual((await withCookie()).status, 401, 'the old session survived a password change');
});

test('a session token minted without a version is refused', async () => {
  const admins = require('../src/services/admins');
  const { createToken } = require('../src/utils/session');
  await admins.upsertAdmin('legacy', 'some-password');

  // What the pre-versioning code produced: a correctly signed, unexpired token
  // with no `tv` claim. It must not pass as version 0.
  const token = createToken('legacy', { role: 'admin' });
  const stripped = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
  delete stripped.tv;
  const part = Buffer.from(JSON.stringify(stripped)).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(part).digest('base64url');

  const res = await fetch(`${base}/api/v1/overview`, { headers: { cookie: `_2t1_sess=${part}.${sig}` } });
  assert.strictEqual(res.status, 401);
});

/* -------------------------------- health -------------------------------- */

test('health check reports the database is reachable', async () => {
  const res = await fetch(`${base}/health`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).status, 'ok');
});
