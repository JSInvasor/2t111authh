'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { obfuscate, rc4 } = require('../src/services/obfuscator');
const luamin = require('luamin');

let fengari = null;
try {
  fengari = require('fengari');
} catch {
  /* optional — the Lua-execution test is skipped without it */
}

const S = (source) => ({ id: 'x' + Math.random(), source, updated_at: 1 });

// Decrypt a stub back to source in JS (RC4 is symmetric).
function decrypt(stub) {
  const lines = stub.split('\n');
  const key = Buffer.from(lines[0].match(/="([^"]*)"/)[1], 'base64');
  const data = Buffer.from(lines[1].match(/="([^"]*)"/)[1], 'base64');
  return rc4(key, data).toString('utf8');
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

test('the Lua stub actually decrypts & runs (fengari)', { skip: !fengari }, () => {
  const { lua, lauxlib, lualib, to_luastring } = fengari;
  const run = (code) => {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    const st = lauxlib.luaL_dostring(L, to_luastring(code));
    if (st !== lua.LUA_OK) return { ok: false, err: lua.lua_tojsstring(L, -1) };
    lua.lua_getglobal(L, to_luastring('__R'));
    return { ok: true, val: lua.lua_tonumber(L, -1) };
  };
  for (const min of [false, true]) {
    const r = run(obfuscate(S('local a=20\nlocal b=22\n__R=a+b'), { minify: min }));
    assert.ok(r.ok, r.err);
    assert.strictEqual(r.val, 42);
  }
});
