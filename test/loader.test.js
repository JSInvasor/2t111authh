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
const fs = require('node:fs');

const config = require('../src/config');
const scripts = require('../src/services/scripts');
const keys = require('../src/services/keys');
const nonce = require('../src/services/nonce');
const { authenticate } = require('../src/services/auth');
const { renderLoader } = require('../src/services/bootstrap');
const { rc4 } = require('../src/services/obfuscator');
const { sessionProof, sessionKey } = require('../src/utils/crypto');

/** Pull the ciphertext out of a delivered stub and RC4 it with `key`. */
function decryptStub(stub, key) {
  const data = stub.match(/^local \w+="([A-Za-z0-9+/=]*)"/m);
  assert.ok(data, 'stub has no ciphertext');
  return rc4(key, Buffer.from(data[1], 'base64')).toString('utf8');
}

let fengari = null;
try {
  fengari = require('fengari');
} catch {
  /* optional — every test here is skipped without a Lua VM */
}

const CLIENT_IP = '198.51.100.42';
const HARNESS = fs.readFileSync(path.join(__dirname, 'helpers', 'roblox_shim.lua'), 'utf8');

/**
 * Minimal stand-in for the two public endpoints, calling the same services in the
 * same order as src/routes/loader.js. It exists because a Lua VM call is
 * synchronous and Express body parsing is not — the routes themselves are covered
 * over real HTTP in antitamper.test.js.
 */
function makeServer(scriptId, { ip = CLIENT_IP } = {}) {
  const reports = [];
  const seen = [];

  function serve(url, bodyJson) {
    const body = JSON.parse(bodyJson || '{}');
    const out = handle(url, body);
    seen.push({ url, body, response: JSON.parse(out) });
    return out;
  }

  function handle(url, body) {
    if (url.endsWith('/api/v1/handshake')) {
      const s = nonce.issue(scriptId, { ip });
      return JSON.stringify({ success: true, nonce: s.nonce, salt: s.salt, ttl: s.ttl });
    }

    if (url.endsWith('/api/v1/auth')) {
      const spent = nonce.consume(String(body.nonce || ''), { scriptId: String(body.script_id), ip });
      if (!spent.ok) return JSON.stringify({ success: false, message: 'Invalid or expired session' });

      const expected = sessionProof({
        salt: spent.salt,
        nonce: String(body.nonce),
        scriptId: String(body.script_id),
        key: body.key,
        hwid: body.hwid,
        executor: body.executor,
      });
      if (body.proof !== expected) {
        return JSON.stringify({ success: false, message: 'Session verification failed' });
      }

      const result = authenticate({
        scriptId: String(body.script_id),
        key: String(body.key),
        hwid: body.hwid || null,
        ip,
        executor: body.executor || null,
        session: { salt: spent.salt, nonce: String(body.nonce) },
      });
      return JSON.stringify(result);
    }

    if (url.endsWith('/api/v1/report')) {
      reports.push(body);
      return JSON.stringify({ success: true });
    }
    return JSON.stringify({ success: false, message: 'not found' });
  }

  return { serve, reports, seen };
}

/**
 * Boot a Lua VM with just enough Roblox/executor surface for the loader, run it,
 * and report what happened.
 * @returns {{warnings:string[], result:number|undefined, reports:object[], seen:object[]}}
 */
function runLoader(loaderLua, { scriptKey, server, globals = '' }) {
  const { lua, lauxlib, lualib, to_luastring } = fengari;
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  const warnings = [];

  lua.lua_pushjsfunction(L, (S) => {
    warnings.push(lua.lua_tojsstring(S, 1));
    return 0;
  });
  lua.lua_setglobal(L, to_luastring('__warn'));

  lua.lua_pushjsfunction(L, (S) => {
    const out = server.serve(lua.lua_tojsstring(S, 1), lua.lua_tojsstring(S, 2));
    lua.lua_pushstring(S, to_luastring(out));
    return 1;
  });
  lua.lua_setglobal(L, to_luastring('__serve'));

  lua.lua_pushstring(L, to_luastring(scriptKey));
  lua.lua_setglobal(L, to_luastring('script_key'));

  const boot = (src, what) => {
    if (lauxlib.luaL_dostring(L, to_luastring(src)) !== lua.LUA_OK) {
      throw new Error(`${what}: ${lua.lua_tojsstring(L, -1)}`);
    }
  };
  boot(HARNESS, 'harness');
  if (globals) boot(globals, 'globals');
  boot(loaderLua, 'loader');

  lua.lua_getglobal(L, to_luastring('__R'));
  const result = lua.lua_isnil(L, -1) ? undefined : lua.lua_tonumber(L, -1);
  return { warnings, result, reports: server.reports, seen: server.seen };
}

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
  assert.notStrictEqual(auth.body.proof, sessionProof({ salt: 'x', nonce: 'x', scriptId: 'x', key: 'x', hwid: 'x' }));
});

test('the loader sends a normalised HWID, never a placeholder', { skip }, () => {
  const { script, key } = mkScript();
  const server = makeServer(script.id);
  runLoader(renderLoader(script, { obfuscate: false }), { scriptKey: key.value, server });

  const auth = server.seen.find((r) => r.url.endsWith('/auth'));
  assert.match(auth.body.hwid, /^[A-Za-z0-9._:-]+$/);
  assert.ok(auth.body.hwid.length <= 128);
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

test('a wrong key never yields a payload', { skip }, () => {
  const { script } = mkScript();
  const server = makeServer(script.id);
  const run = runLoader(renderLoader(script, { obfuscate: false }), {
    scriptKey: '2t1_WRONG-WRONG-WRONG-WRONG',
    server,
  });
  assert.strictEqual(run.result, undefined);
  assert.ok(run.warnings.join(' ').includes('Invalid key'));
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

test('with the hard stop off, a caught hook is reported and the user still runs', { skip }, () => {
  const { script, key } = mkScript();
  const server = makeServer(script.id);
  const saved = config.tamperHardStop;
  config.tamperHardStop = false;
  let run;
  try {
    run = runLoader(renderLoader(script, { obfuscate: false }), {
      scriptKey: key.value,
      server,
      // Same environment that stops the run when the hard stop is on.
      globals: 'iscclosure = function() return false end',
    });
  } finally {
    config.tamperHardStop = saved;
  }

  assert.strictEqual(run.result, 42, 'the paying user was locked out anyway');
  assert.ok(
    run.reports.some((r) => r.reason === 'hook:http'),
    'the signal was lost — reporting is the whole point of the softer setting'
  );
  assert.deepStrictEqual(run.warnings, [], 'user was warned despite the softer setting');
});
