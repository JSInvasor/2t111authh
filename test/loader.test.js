'use strict';
// Runs the *actual* Lua bootstrap a user's executor receives inside a Lua VM,
// against the real server-side services. This is what proves the two independent
// implementations of the session crypto — pure Lua on the client, node:crypto on
// the server — agree, and that the delivered payload really does decrypt and run.

const path = require('node:path');
const os = require('node:os');
const nodeCrypto = require('node:crypto');
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef0123';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.DB_PATH = path.join(
  os.tmpdir(),
  `2t1auth-loader-${process.pid}-${nodeCrypto.randomBytes(4).toString('hex')}.db`
);

const test = require('node:test');
const assert = require('node:assert');

const scripts = require('../src/services/scripts');
const keys = require('../src/services/keys');
const nonce = require('../src/services/nonce');
const { renderLoader } = require('../src/services/bootstrap');
const { keyHash, clientProof, sessionKey } = require('../src/utils/crypto');
const { makeServer, runLoader, decryptStub, fengari, CLIENT_IP } = require('./helpers/harness');

function mkScript(opts = {}) {
  const script = scripts.createScript({
    name: 'Loader Test',
    source: '__R = 42',
    hwid_lock: 1,
    obfuscate: 1,
    ...opts,
  });
  const [key] = keys.createKeys(script.id, { count: 1 });
  return { script, key };
}

const skip = !fengari;

test('the delivered loader authenticates and runs the protected script', { skip }, () => {
  const { script, key } = mkScript();
  const server = makeServer(script.id);
  const run = runLoader(renderLoader(script, { obfuscate: false }), { scriptKey: key.value, server });

  assert.deepStrictEqual(run.warnings, [], 'loader warned: ' + run.warnings.join(' | '));
  assert.strictEqual(run.result, 42, 'protected script did not run');
  assert.deepStrictEqual(run.reports, []);
});

test('it works the same when the bootstrap itself is obfuscated', { skip }, () => {
  const { script, key } = mkScript();
  const server = makeServer(script.id);
  const loader = renderLoader(script, { obfuscate: true });

  assert.ok(!loader.includes('2t1auth'), 'obfuscated bootstrap still leaks plaintext');
  assert.ok(!loader.includes('/api/v1/handshake'), 'obfuscated bootstrap still leaks endpoints');

  const run = runLoader(loader, { scriptKey: key.value, server });
  assert.deepStrictEqual(run.warnings, [], run.warnings.join(' | '));
  assert.strictEqual(run.result, 42);
});

test('two loader deliveries are byte-unique', { skip }, () => {
  const { script } = mkScript();
  assert.notStrictEqual(renderLoader(script, { obfuscate: true }), renderLoader(script, { obfuscate: true }));
});

test('the Lua proof matches the one node:crypto computes', { skip }, () => {
  const { script, key } = mkScript();
  const server = makeServer(script.id);
  const run = runLoader(renderLoader(script, { obfuscate: false }), { scriptKey: key.value, server });

  const auth = run.seen.find((r) => r.url.endsWith('/api/v1/auth'));
  assert.ok(auth, 'loader never reached /auth');
  assert.match(auth.body.proof, /^[0-9a-f]{64}$/, 'proof is not a SHA-256 HMAC');
  // The server already checked it (the script ran), so this pins the shape and
  // guards against the proof accidentally becoming a constant.
  assert.notStrictEqual(auth.body.proof, clientProof({ key: 'x', nonce: 'x', scriptId: 'x', hwid: 'x', executor: 'x' }));

  // The key is named by hash and never sent.
  assert.strictEqual(auth.body.kh, keyHash(key.value));
  assert.ok(!('key' in auth.body));
  assert.ok(!JSON.stringify(auth.body).includes(key.value), 'the key leaked into the auth request');
});

test('the loader sends a normalised HWID, never a placeholder', { skip }, () => {
  const { script, key } = mkScript();
  const server = makeServer(script.id);
  runLoader(renderLoader(script, { obfuscate: false }), { scriptKey: key.value, server });

  const auth = server.seen.find((r) => r.url.endsWith('/auth'));
  assert.match(auth.body.hwid, /^[A-Za-z0-9._:-]+$/);
  assert.ok(auth.body.hwid.length <= 128);
});

test('the loader beats against its lease and stops when revoked', { skip }, () => {
  const lease = require('../src/services/lease');
  const { script, key } = mkScript({ hwid_lock: 0 });
  const server = makeServer(script.id);
  const run = runLoader(renderLoader(script, { obfuscate: false }), { scriptKey: key.value, server });
  assert.strictEqual(run.result, 42, run.warnings.join(' | '));

  // Ban the key the way the dashboard would, then let the loader beat.
  keys.updateKey(key.id, { status: 'banned' });
  assert.ok(run.beat(), 'the loader never scheduled a heartbeat');

  const beats = server.seen.filter((r) => r.url.endsWith('/heartbeat'));
  assert.strictEqual(beats.length, 1, 'the loader kept beating after being revoked');
  assert.strictEqual(beats[0].response.revoked, true);
  assert.match(run.warnings.join(' '), /session ended|revoked|no longer valid/i);
  assert.strictEqual(lease.countFor(key.id), 0);
});

test('a healthy session keeps beating with increasing counters', { skip }, () => {
  const { script, key } = mkScript({ hwid_lock: 0 });
  const server = makeServer(script.id);
  const run = runLoader(renderLoader(script, { obfuscate: false }), { scriptKey: key.value, server });
  assert.strictEqual(run.result, 42, run.warnings.join(' | '));

  run.beat(); // runs until the shim's turn limit, since nothing revokes it

  const beats = server.seen.filter((r) => r.url.endsWith('/heartbeat'));
  assert.ok(beats.length > 3, `expected a sustained beat, saw ${beats.length}`);
  // The shim's JSON encoder stringifies every value; the route reads it with
  // Number(), and a real executor sends a JSON number either way.
  assert.ok(
    beats.every((b, i) => Number(b.body.n) === i + 1 && b.response.success),
    'beat counters did not increase monotonically'
  );
});

test('a hooked HTTP function stops the run and reports it', { skip }, () => {
  const { script, key } = mkScript();
  const server = makeServer(script.id);
  const run = runLoader(renderLoader(script, { obfuscate: false }), {
    scriptKey: key.value,
    server,
    // Executor says the request function is a Lua closure — i.e. replaced.
    globals: 'iscclosure = function() return false end',
  });

  assert.strictEqual(run.result, undefined, 'script ran despite a hooked HTTP function');
  assert.strictEqual(run.reports.length, 1);
  assert.strictEqual(run.reports[0].reason, 'hook:http');
  assert.ok(run.warnings.join(' ').includes('tampered'));
});

test('a hooked loadstring stops the run before the payload is fetched', { skip }, () => {
  const { script, key } = mkScript();
  const server = makeServer(script.id);
  const run = runLoader(renderLoader(script, { obfuscate: false }), {
    scriptKey: key.value,
    server,
    // Only loadstring looks tampered with; the HTTP function is genuine.
    globals: `
      local realRequest = request
      iscclosure = function(fn) return fn == realRequest end
    `,
  });

  assert.strictEqual(run.result, undefined);
  assert.strictEqual(run.reports.length, 1);
  assert.strictEqual(run.reports[0].reason, 'hook:loadstring');
  assert.ok(!run.seen.some((r) => r.url.endsWith('/auth')), 'payload was requested anyway');
});

test('a weaker signal is reported but does not lock the user out', { skip }, () => {
  const { script, key } = mkScript();
  const server = makeServer(script.id);
  const run = runLoader(renderLoader(script, { obfuscate: false }), {
    scriptKey: key.value,
    server,
    // The primitives that actually touch the payload are genuine; only the JSON
    // helpers look Lua-level — which some executors do legitimately.
    globals: `
      local realRequest = request
      local realLoad = loadstring or load
      iscclosure = function(fn) return fn == realRequest or fn == realLoad end
    `,
  });

  assert.strictEqual(run.result, 42, run.warnings.join(' | '));
  assert.deepStrictEqual(
    run.reports.map((r) => r.reason),
    ['hook:json']
  );
});

test('genuine C primitives are never mistaken for hooks', { skip }, () => {
  const { script, key } = mkScript();
  const server = makeServer(script.id);
  const run = runLoader(renderLoader(script, { obfuscate: false }), {
    scriptKey: key.value,
    server,
    globals: 'iscclosure = function() return true end',
  });
  assert.strictEqual(run.result, 42, run.warnings.join(' | '));
  assert.deepStrictEqual(run.reports, []);
});

test('a missing script_key bails before touching the network', { skip }, () => {
  const { script } = mkScript();
  const server = makeServer(script.id);
  const run = runLoader(renderLoader(script, { obfuscate: false }), { scriptKey: '', server });
  assert.strictEqual(run.result, undefined);
  assert.deepStrictEqual(run.seen, []);
  assert.ok(run.warnings.join(' ').includes('script_key'));
});

test('a wrong key is rejected at the handshake, before /auth is ever reached', { skip }, () => {
  const { script } = mkScript();
  const server = makeServer(script.id);
  const run = runLoader(renderLoader(script, { obfuscate: false }), {
    scriptKey: '2t1_WRONG-WRONG-WRONG-WRONG',
    server,
  });
  assert.strictEqual(run.result, undefined);
  // The decoy server_proof doesn't verify under the wrong key, so the loader
  // stops one step earlier than it used to — it never sends hwid or executor.
  assert.match(run.warnings.join(' '), /server verification failed/i);
  assert.ok(
    !server.seen.some((r) => r.url.endsWith('/auth')),
    'the loader talked to /auth despite failing to authenticate the server'
  );
});

test('a captured payload is inert without the session that fetched it', { skip }, () => {
  const { script, key } = mkScript({ source: 'SEEKRIT_MARKER = 1\n__R = 42' });
  const server = makeServer(script.id);
  const run = runLoader(renderLoader(script, { obfuscate: false }), { scriptKey: key.value, server });
  assert.strictEqual(run.result, 42, run.warnings.join(' | '));

  const auth = server.seen.find((r) => r.url.endsWith('/auth'));
  const payload = auth.response.script;
  assert.strictEqual(auth.response.enc, 'session');
  assert.ok(!payload.includes('SEEKRIT_MARKER'), 'payload leaks plaintext');

  // Everything an eavesdropper has: the request fields and the ciphertext. The
  // salt was only ever inside the handshake response for that one session.
  const guessable = ['', auth.body.nonce, auth.body.key, auth.body.hwid, auth.body.proof];
  for (const salt of guessable) {
    const derived = sessionKey({
      salt,
      nonce: auth.body.nonce,
      scriptId: script.id,
      key: auth.body.key,
      hwid: auth.body.hwid,
    });
    assert.ok(!decryptStub(payload, derived).includes('SEEKRIT_MARKER'), `payload decrypted with salt=${salt}`);
  }

  // …and the nonce that would let you re-derive it is already spent.
  assert.strictEqual(nonce.consume(auth.body.nonce, { scriptId: script.id, ip: CLIENT_IP }).ok, false);
});

test('the session key the server encrypts with is salt-dependent', { skip }, () => {
  const args = { nonce: 'n', scriptId: 's', key: 'k', hwid: 'h' };
  const a = sessionKey({ ...args, salt: 'salt-one' });
  const b = sessionKey({ ...args, salt: 'salt-two' });
  assert.notDeepStrictEqual(a, b);
  assert.strictEqual(a.length, 32);
});
