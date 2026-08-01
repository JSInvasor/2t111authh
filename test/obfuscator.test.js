'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { obfuscate, obfuscateChunk, rc4, _minifyCacheSize } = require('../src/services/obfuscator');
const luamin = require('luamin');

let fengari = null;
try {
  fengari = require('fengari');
} catch {
  /* optional — the Lua-execution tests are skipped without it */
}

const S = (source) => ({ id: 'x' + Math.random(), source, updated_at: 1 });

// Pull the ciphertext (and the embedded key, in inline mode) back out of a stub.
function parts(stub) {
  const data = stub.match(/^local \w+="([A-Za-z0-9+/=]*)"/m);
  const key = stub.match(/=\w+\("([A-Za-z0-9+/=]+)"\)/);
  assert.ok(data, 'stub has no ciphertext');
  return {
    data: Buffer.from(data[1], 'base64'),
    key: key ? Buffer.from(key[1], 'base64') : null,
  };
}

// Decrypt a stub back to source in JS (RC4 is symmetric).
function decrypt(stub, key = null) {
  const p = parts(stub);
  return rc4(key || p.key, p.data).toString('utf8');
}

// Run a Lua chunk, optionally with a vararg, and read back the global __R.
function runLua(code, arg) {
  const { lua, lauxlib, lualib, to_luastring } = fengari;
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) {
    return { ok: false, err: 'load: ' + lua.lua_tojsstring(L, -1) };
  }
  let argc = 0;
  if (arg !== undefined) {
    lua.lua_pushstring(L, arg);
    argc = 1;
  }
  if (lua.lua_pcall(L, argc, 0, 0) !== lua.LUA_OK) {
    return { ok: false, err: 'run: ' + lua.lua_tojsstring(L, -1) };
  }
  lua.lua_getglobal(L, to_luastring('__R'));
  return { ok: true, val: lua.lua_tonumber(L, -1) };
}

test('round-trip without minify preserves source', () => {
  const src = '__R = 1 + 2';
  assert.strictEqual(decrypt(obfuscate(S(src), { minify: false })), src);
});

test('minify embeds the minified source', () => {
  const src = 'local a = 1\nlocal b = 2\n__R = a + b';
  assert.strictEqual(decrypt(obfuscate(S(src), { minify: true })), luamin.minify(src));
});

test('unparseable (Luau) source falls back to original, no throw', () => {
  const luau = 'local x: number = 5\n__R = x';
  assert.throws(() => luamin.minify(luau));
  assert.strictEqual(decrypt(obfuscate(S(luau), { minify: true })), luau);
});

test('plaintext does not appear in the stub', () => {
  assert.ok(!obfuscate(S('print("SEEKRIT_TOKEN")'), { minify: false }).includes('SEEKRIT_TOKEN'));
});

test('two deliveries of the same source differ (random key)', () => {
  const s = S('__R = 5');
  assert.notStrictEqual(obfuscate(s, { minify: false }), obfuscate(s, { minify: false }));
});

test('session mode keeps the key out of the payload', () => {
  const key = crypto.randomBytes(32);
  const stub = obfuscate(S('__R = 7'), { minify: false, key });
  assert.strictEqual(parts(stub).key, null, 'stub still embeds a key');
  assert.ok(!stub.includes(key.toString('base64')));
  assert.strictEqual(decrypt(stub, key), '__R = 7');
});

test('session payloads are worthless without the session key', () => {
  const stub = obfuscate(S('print("SEEKRIT_TOKEN")'), { minify: false, key: crypto.randomBytes(32) });
  // Everything an attacker has is in the stub; none of it decrypts the payload.
  assert.ok(!decrypt(stub, crypto.randomBytes(32)).includes('SEEKRIT_TOKEN'));
});

test('the minify cache is bounded', () => {
  // Every S() has a fresh id, so an unbounded cache would end up holding 400
  // minified copies (and would never release deleted scripts).
  for (let i = 0; i < 400; i++) obfuscate(S('__R = ' + i), { minify: true });
  assert.ok(_minifyCacheSize() <= 200, `cache grew to ${_minifyCacheSize()}`);
});

test('the Lua stub decrypts & runs — inline key (fengari)', { skip: !fengari }, () => {
  for (const min of [false, true]) {
    const r = runLua(obfuscate(S('local a=20\nlocal b=22\n__R=a+b'), { minify: min }));
    assert.ok(r.ok, r.err);
    assert.strictEqual(r.val, 42);
  }
});

test('the Lua stub decrypts & runs — session key (fengari)', { skip: !fengari }, () => {
  const key = crypto.randomBytes(32);
  for (const min of [false, true]) {
    const stub = obfuscate(S('local a=20\nlocal b=22\n__R=a+b'), { minify: min, key });
    const r = runLua(stub, key);
    assert.ok(r.ok, r.err);
    assert.strictEqual(r.val, 42);
  }
});

test('a session stub runs nothing without the right key (fengari)', { skip: !fengari }, () => {
  const stub = obfuscate(S('__R=42'), { minify: false, key: crypto.randomBytes(32) });
  for (const arg of [undefined, '', crypto.randomBytes(32)]) {
    const r = runLua(stub, arg);
    assert.ok(r.ok, r.err); // bails cleanly, never errors
    assert.ok(!r.val, 'stub executed with a bad key');
  }
});

test('a tampered payload fails the integrity check (fengari)', { skip: !fengari }, () => {
  const stub = obfuscate(S('__R=42'), { minify: false });
  // Flip one base64 character of the ciphertext.
  const broken = stub.replace(
    /^local (\w+)="([A-Za-z0-9+/=]+)"/m,
    (_m, n, d) => `local ${n}="${d.slice(0, 4)}${d[4] === 'A' ? 'B' : 'A'}${d.slice(5)}"`
  );
  const r = runLua(broken);
  assert.ok(r.ok, r.err);
  assert.ok(!r.val, 'corrupted payload still executed');
});

test('base64 payloads containing + and / decode correctly (fengari)', { skip: !fengari }, () => {
  // The stub decodes base64 by table lookup; "+" and "/" are the two characters
  // a pattern-based decoder would trip over.
  //
  // Whether they turn up is down to the ciphertext, which is random — so the
  // padding below is what makes this deterministic, not the retry. A one-line
  // source encodes to 8 base64 characters, and 8 characters miss "+" about 88%
  // of the time; that flaked roughly one run in sixty. Padding the source out
  // to a few hundred bytes puts several hundred characters in the payload, and
  // the chance of one missing either symbol falls to ~1e-3. Retries are kept
  // only to drive that into the ground.
  const padding = "local _pad='" + 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(12) + "'\n";
  let sawPlus = false;
  let sawSlash = false;
  for (let i = 0; i < 8 && !(sawPlus && sawSlash); i++) {
    const stub = obfuscate(S(padding + '__R=42'), { minify: false });
    const b64 = parts(stub).data.toString('base64');
    sawPlus = sawPlus || b64.includes('+');
    sawSlash = sawSlash || b64.includes('/');
    const r = runLua(stub);
    assert.ok(r.ok, r.err);
    assert.strictEqual(r.val, 42);
  }
  assert.ok(sawPlus && sawSlash, 'never generated a payload with + and /');
});

test('obfuscateChunk protects a standalone chunk (fengari)', { skip: !fengari }, () => {
  const r = runLua(obfuscateChunk('local a=1\nlocal b=41\n__R=a+b'));
  assert.ok(r.ok, r.err);
  assert.strictEqual(r.val, 42);
});
