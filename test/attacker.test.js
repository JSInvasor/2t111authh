'use strict';
// Adversarial tests: each one plays an attacker and asserts the system refuses.
//
// The rest of the suite proves the happy path works. This file exists to prove
// the unhappy paths CAN'T — the security properties the README claims are
// checked here rather than asserted in a comment. Every case below is something
// that either worked at some point or is one careless edit away from working.

const path = require('node:path');
const os = require('node:os');
const nodeCrypto = require('node:crypto');
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef0123';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.DB_PATH = path.join(
  os.tmpdir(),
  `2t1auth-attacker-${process.pid}-${nodeCrypto.randomBytes(4).toString('hex')}.db`
);

const test = require('node:test');
const assert = require('node:assert');

const scripts = require('../src/services/scripts');
const keys = require('../src/services/keys');
const { renderLoader } = require('../src/services/bootstrap');
const { makeServer, runLoader, fengari } = require('./helpers/harness');

const skip = !fengari;
const PAYLOAD = '__R = 42';
const INJECTED = '__PWNED = 1337';

function mk(opts = {}) {
  const script = scripts.createScript({ name: 'Attacker Test', source: PAYLOAD, hwid_lock: 1, obfuscate: 1, ...opts });
  const [key] = keys.createKeys(script.id, { count: 1 });
  return { script, key: key.value };
}

/** Run the real delivered loader against a server that misbehaves in some way. */
function attack(script, key, tamper) {
  const server = makeServer(script.id, { tamper });
  const run = runLoader(renderLoader(script, { obfuscate: false }), { scriptKey: key, server });
  return { ...run, server };
}

/** Assert the loader ran nothing at all. */
function assertInert(run, what) {
  assert.strictEqual(run.result, undefined, `${what}: the protected script ran`);
  assert.strictEqual(run.globals('__PWNED'), undefined, `${what}: injected code ran`);
}

/* --------------------- a server that isn't ours at all --------------------- */

test('a hostile endpoint cannot make the loader run its code', { skip }, () => {
  // The whole attack: answer the loader's HTTP calls. No key, no nonce, no
  // proof, no session secret — just the ability to reply. This is a poisoned DNS
  // entry, a hostile proxy, a captive portal. It used to work: the loader took
  // any response with no `enc` field as plaintext Lua and executed it.
  const { script, key } = mk();
  const hostile = {
    serve(url) {
      if (url.endsWith('/api/v1/handshake')) {
        return JSON.stringify({ success: true, nonce: 'n', salt: 's', ttl: 20000, server_proof: 'ff'.repeat(32) });
      }
      if (url.endsWith('/api/v1/auth')) {
        return JSON.stringify({ success: true, script: INJECTED, version: '1.0.0' });
      }
      return JSON.stringify({ success: true });
    },
    reports: [],
    seen: [],
  };

  const run = runLoader(renderLoader(script, { obfuscate: false }), { scriptKey: key, server: hostile });
  assertInert(run, 'hostile endpoint');
  assert.match(run.warnings.join(' '), /server verification failed/i);
});

test('a hostile endpoint never learns the key', { skip }, () => {
  const { script, key } = mk();
  const sent = [];
  const hostile = {
    serve(url, body) {
      sent.push(body);
      return JSON.stringify({ success: true, nonce: 'n', salt: 's', ttl: 20000, server_proof: 'ff'.repeat(32) });
    },
    reports: [],
    seen: [],
  };

  runLoader(renderLoader(script, { obfuscate: false }), { scriptKey: key, server: hostile });
  assert.ok(sent.length > 0, 'the loader never spoke to the server at all');
  assert.ok(!sent.join('').includes(key), 'the key was sent to an unauthenticated endpoint');
});

/* ------------------- our server, answers rewritten in flight ------------------- */

test('a payload downgraded to plaintext is refused', { skip }, () => {
  // The response is otherwise genuine — the attacker just strips the encryption
  // and substitutes their own source, the way a MITM would.
  const { script, key } = mk();
  const run = attack(script, key, (url, res) => {
    if (!url.endsWith('/api/v1/auth') || !res.success) return res;
    return { ...res, enc: undefined, script: INJECTED };
  });

  assertInert(run, 'plaintext downgrade');
  assert.match(run.warnings.join(' '), /verification failed|refusing/i);
});

test('a payload swapped for another is refused', { skip }, () => {
  // Even a legitimately-signed payload from somewhere else must not be accepted:
  // resp_proof is bound to this session's nonce.
  const a = mk();
  const b = mk();

  let stolen = null;
  attack(a.script, a.key, (url, res) => {
    if (url.endsWith('/api/v1/auth') && res.success) stolen = { script: res.script, resp_proof: res.resp_proof };
    return res;
  });
  assert.ok(stolen, 'never captured a payload to replay');

  const run = attack(b.script, b.key, (url, res) => (url.endsWith('/api/v1/auth') && res.success ? { ...res, ...stolen } : res));
  assertInert(run, 'payload swap');
});

test('flipping a single byte of the ciphertext is refused', { skip }, () => {
  const { script, key } = mk();
  const run = attack(script, key, (url, res) => {
    if (!url.endsWith('/api/v1/auth') || !res.success) return res;
    const bytes = Buffer.from(res.script, 'utf8');
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    return { ...res, script: bytes.toString('utf8') };
  });

  assertInert(run, 'bit flip');
  assert.match(run.warnings.join(' '), /verification failed|refusing/i);
});

test('stripping the response signature is refused', { skip }, () => {
  const { script, key } = mk();
  const run = attack(script, key, (url, res) =>
    url.endsWith('/api/v1/auth') && res.success ? { ...res, resp_proof: undefined } : res
  );
  assertInert(run, 'unsigned response');
});

test('a forged server_proof stops the loader before it sends anything', { skip }, () => {
  const { script, key } = mk();
  const run = attack(script, key, (url, res) =>
    url.endsWith('/api/v1/handshake') ? { ...res, server_proof: 'ab'.repeat(32) } : res
  );

  assertInert(run, 'forged server proof');
  assert.ok(
    !run.server.seen.some((r) => r.url.endsWith('/auth')),
    'the loader proceeded to /auth despite failing to authenticate the server'
  );
});

/* ------------------------------ replay & reuse ------------------------------ */

test('a captured exchange replayed verbatim yields nothing', { skip }, () => {
  const { script, key } = mk();

  const first = attack(script, key, null);
  assert.strictEqual(first.result, 42, 'the honest run should have worked');

  const authCall = first.server.seen.find((r) => r.url.endsWith('/auth'));
  const captured = authCall.body;

  // Replay the exact bytes against a fresh server. The nonce is single-use, so
  // it is already gone.
  const replayServer = makeServer(script.id);
  const answer = JSON.parse(replayServer.serve(`x/api/v1/auth`, JSON.stringify(captured)));
  assert.strictEqual(answer.success, false, 'a captured auth request was accepted twice');
});

test('a captured payload does not decrypt outside its session', { skip }, () => {
  const { script, key } = mk({ source: 'SEEKRIT = 1\n__R = 42' });

  let payload = null;
  const first = attack(script, key, (url, res) => {
    if (url.endsWith('/api/v1/auth') && res.success) payload = res.script;
    return res;
  });
  assert.strictEqual(first.result, 42);
  assert.ok(payload && !payload.includes('SEEKRIT'), 'the payload shipped in the clear');

  // Hand that same ciphertext to a different session (fresh handshake, fresh
  // salt). The session key no longer derives to the same value, so the stub's
  // checksum fails and it returns without running anything.
  const run = attack(script, key, (url, res) => {
    if (!url.endsWith('/api/v1/auth') || !res.success) return res;
    return { ...res, script: payload };
  });
  assertInert(run, 'cross-session payload');
});

/* --------------------------- key-scoped attacks --------------------------- */

test('a payload minted for one script cannot be served for another', { skip }, () => {
  const a = mk({ source: '__R = 1' });
  const b = mk({ source: '__R = 2' });

  let fromA = null;
  attack(a.script, a.key, (url, res) => {
    if (url.endsWith('/api/v1/auth') && res.success) fromA = res.script;
    return res;
  });

  const run = attack(b.script, b.key, (url, res) =>
    url.endsWith('/api/v1/auth') && res.success ? { ...res, script: fromA } : res
  );
  assertInert(run, 'cross-script payload');
});

test('knowing a key value is not enough to use it', { skip }, () => {
  // The attacker has the key string (a screenshot, a leaked list) but the HWID
  // lock is already bound to someone else's device.
  const { script, key } = mk({ hwid_lock: 1 });
  assert.strictEqual(attack(script, key, null).result, 42, 'the owner should bind first');

  const run = attack(script, key, null); // same harness, but a fresh HWID would differ
  const auth = run.server.seen.find((r) => r.url.endsWith('/auth'));
  assert.ok(auth, 'never reached /auth');

  // Directly: a second device with the same key is refused by the server.
  const { authenticate } = require('../src/services/auth');
  const other = authenticate({
    scriptId: script.id,
    key,
    hwid: 'SOME-OTHER-DEVICE',
    executor: 'synapse',
    ip: '203.0.113.9',
  });
  assert.strictEqual(other.success, false);
  assert.match(other.message, /HWID/i);
});
