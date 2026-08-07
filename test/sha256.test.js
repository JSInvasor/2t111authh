'use strict';
// The loader computes its session proof and session key with a pure-Lua
// SHA-256; the server uses node:crypto. If the two ever disagree, every auth
// fails its proof check — so pin them against each other here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let fengari = null;
try {
  fengari = require('fengari');
} catch {
  /* optional — skipped without a Lua VM */
}

const SHA256_LUA = fs.readFileSync(path.join(__dirname, '..', 'lua', 'sha256.lua'), 'utf8');

// A bit32 built from arithmetic: exercises the branch Luau takes, in a VM
// (Lua 5.3) that dropped the library. Without it only the fallback gets tested.
const BIT32_SHIM = `
bit32 = {
  band=function(a,b) local r,p=0.0,1.0 for _=1,32 do local x,y=a%2,b%2 if x==1 and y==1 then r=r+p end a=(a-x)/2 b=(b-y)/2 p=p*2 end return r end,
  bor=function(a,b) local r,p=0.0,1.0 for _=1,32 do local x,y=a%2,b%2 if x==1 or y==1 then r=r+p end a=(a-x)/2 b=(b-y)/2 p=p*2 end return r end,
  bxor=function(a,b) local r,p=0.0,1.0 for _=1,32 do local x,y=a%2,b%2 if x~=y then r=r+p end a=(a-x)/2 b=(b-y)/2 p=p*2 end return r end,
  bnot=function(a) return 4294967295.0-a end,
  rshift=function(a,n) return math.floor(a/2^n)%4294967296.0 end,
  lshift=function(a,n) return (a*2^n)%4294967296.0 end,
}`;

function luaState(prelude) {
  const { lua, lauxlib, lualib, to_luastring } = fengari;
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const src = `${prelude}\n${SHA256_LUA}
function SH(s) return sha256hex(s) end
function RAW(s) return sha256raw(s) end
function HM(k, m) return hmac256hex(k, m) end`;
  if (lauxlib.luaL_dostring(L, to_luastring(src)) !== lua.LUA_OK) {
    throw new Error('lua: ' + lua.lua_tojsstring(L, -1));
  }
  return L;
}

function call(L, fn, ...args) {
  const { lua, to_luastring } = fengari;
  lua.lua_getglobal(L, to_luastring(fn));
  for (const a of args) lua.lua_pushstring(L, Buffer.from(a, 'utf8'));
  if (lua.lua_pcall(L, args.length, 1, 0) !== lua.LUA_OK) {
    throw new Error('lua: ' + lua.lua_tojsstring(L, -1));
  }
  const out = Buffer.from(lua.lua_tostring(L, -1));
  lua.lua_pop(L, 1);
  return out;
}

const skip = !fengari;

// Both branches of the bit-op selection must produce identical digests.
for (const [label, prelude] of [
  ['arithmetic fallback', 'bit32 = nil'],
  ['bit32 path', BIT32_SHIM],
]) {
  test(`SHA-256 matches node:crypto — ${label}`, { skip }, () => {
    const L = luaState(prelude);
    // Every length around the 64-byte block and the 56-byte padding boundary,
    // where the message-schedule word becomes 0x80000000.
    for (let n = 0; n <= 200; n++) {
      const msg = 'a'.repeat(n);
      assert.strictEqual(
        call(L, 'SH', msg).toString(),
        crypto.createHash('sha256').update(msg).digest('hex'),
        `length ${n}`
      );
    }
    for (const msg of ['', 'abc', '2t1_ABCD1234-EFGH5678|nonce|hwid', 'ünïcødé', 'x'.repeat(1000)]) {
      assert.strictEqual(
        call(L, 'SH', msg).toString(),
        crypto.createHash('sha256').update(msg, 'utf8').digest('hex'),
        JSON.stringify(msg.slice(0, 20))
      );
    }
  });

  test(`HMAC-SHA256 matches node:crypto — ${label}`, { skip }, () => {
    const L = luaState(prelude);
    const cases = [
      ['key', 'msg'],
      ['', 'empty key'],
      ['k'.repeat(64), 'key exactly one block'],
      ['k'.repeat(200), 'key longer than a block'],
      ['salt-value', 'nonce|script|key|hwid|executor'],
      ['s', 'm'.repeat(500)],
    ];
    for (const [k, m] of cases) {
      assert.strictEqual(
        call(L, 'HM', k, m).toString(),
        crypto.createHmac('sha256', Buffer.from(k, 'utf8')).update(m, 'utf8').digest('hex'),
        `${k.slice(0, 10)} / ${m.slice(0, 10)}`
      );
    }
  });
}

test('sha256raw returns the 32 raw digest bytes', { skip }, () => {
  const L = luaState('bit32 = nil');
  const raw = call(L, 'RAW', 'session-key-material');
  assert.strictEqual(raw.length, 32);
  assert.ok(raw.equals(crypto.createHash('sha256').update('session-key-material').digest()));
});

test('the loader hashes exactly the fields the server does', { skip }, () => {
  // Guards against the two sides drifting apart: same joined message, same key.
  // Every derivation in the protocol is pinned here — if any one of them drifts,
  // the corresponding step fails closed and nobody can authenticate at all.
  const {
    keyHash,
    serverProof,
    clientProof,
    reportProof,
    beatProof,
    responseProof,
    sessionKey,
  } = require('../src/utils/crypto');
  const L = luaState('bit32 = nil');
  const f = {
    salt: 'SALT-abc123',
    nonce: 'NONCE-xyz789',
    scriptId: 'deadbeefdeadbeef',
    key: '2t1_AAAA1111-BBBB2222-CCCC3333-DDDD4444',
    hwid: 'DEVICE-0001',
    executor: 'synapse',
  };
  const hex = (...a) => call(L, ...a).toString();

  // kh — how the loader names its key on the wire.
  assert.strictEqual(hex('SH', '2t1kh|' + f.key), keyHash(f.key));

  // server_proof — the loader verifies this before revealing anything.
  assert.strictEqual(
    hex('HM', f.key, '2t1srv|' + [f.nonce, f.salt, f.scriptId].join('|')),
    serverProof(f)
  );

  // client proof — sent with /auth, covering the device token and environment
  // fingerprint so neither can be rewritten in flight.
  const extra = { device: 'a1b2c3d4e5f60718', env: 'ff00ff00ff00ff00' };
  assert.strictEqual(
    hex(
      'HM',
      f.key,
      '2t1cli|' + [f.nonce, f.scriptId, f.hwid, f.executor, extra.device, extra.env].join('|')
    ),
    clientProof({ ...f, ...extra })
  );

  // report proof — sent with /report.
  const reason = 'hook:http';
  assert.strictEqual(
    hex('HM', f.key, '2t1rep|' + [f.nonce, f.scriptId, reason].join('|')),
    reportProof({ ...f, reason })
  );

  // resp_proof — the loader verifies this before running the payload.
  const script = 'return 42';
  const lease = 'LEASE-abc';
  assert.strictEqual(
    hex('HM', f.key, '2t1res|' + [f.nonce, 'session', lease, script].join('|')),
    responseProof({ ...f, enc: 'session', lease, script })
  );

  // heartbeat — one beat against a live lease.
  assert.strictEqual(hex('HM', f.key, '2t1hb|' + [lease, 3].join('|')), beatProof({ ...f, lease, n: 3 }));

  // session key — the cipher key both sides derive independently.
  const luaKey = call(L, 'RAW', [f.salt, f.nonce, f.scriptId, f.key, f.hwid].join('|'));
  assert.ok(luaKey.equals(sessionKey(f)));
});
