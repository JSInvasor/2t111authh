'use strict';
// Shared rig for the tests that run the REAL Lua bootstrap a user's executor
// receives, inside a Lua VM, against the real server-side services.
//
// Requiring this pulls in src/, so a test file must set its env (DB_PATH and
// friends) before requiring it.

const fs = require('node:fs');
const path = require('node:path');

const keys = require('../../src/services/keys');
const nonce = require('../../src/services/nonce');
const lease = require('../../src/services/lease');
const { authenticate } = require('../../src/services/auth');
const { rc4 } = require('../../src/services/obfuscator');
const { serverProof, clientProof, beatProof, responseProof } = require('../../src/utils/crypto');

let fengari = null;
try {
  fengari = require('fengari');
} catch {
  /* optional — callers skip their tests without a Lua VM */
}

const HARNESS_LUA = fs.readFileSync(path.join(__dirname, 'roblox_shim.lua'), 'utf8');
const CLIENT_IP = '198.51.100.42';

/** Pull the ciphertext out of a delivered stub and RC4 it with `key`. */
function decryptStub(stub, key) {
  const data = stub.match(/^local \w+="([A-Za-z0-9+/=]*)"/m);
  if (!data) throw new Error('stub has no ciphertext');
  return rc4(key, Buffer.from(data[1], 'base64')).toString('utf8');
}

/**
 * Stand-in for the two public endpoints, calling the same services in the same
 * order as src/routes/loader.js. It exists because a Lua VM call is synchronous
 * and Express body parsing is not — the routes themselves are covered over real
 * HTTP in api.test.js.
 *
 * @param {string} scriptId
 * @param {{ip?:string, tamper?:(url:string, response:object, ctx:object)=>object}} [opts]
 *   tamper — last-chance hook to rewrite a response before the loader sees it.
 *   This is how the attacker tests play a hostile network without having to
 *   reimplement the protocol.
 */
function makeServer(scriptId, { ip = CLIENT_IP, tamper = null } = {}) {
  const reports = [];
  const seen = [];

  function serve(url, bodyJson) {
    const body = JSON.parse(bodyJson || '{}');
    let response = JSON.parse(handle(url, body));
    if (tamper) response = tamper(url, response, { body, scriptId });
    seen.push({ url, body, response });
    return JSON.stringify(response);
  }

  function handle(url, body) {
    if (url.endsWith('/api/v1/handshake')) {
      const s = nonce.issue(scriptId, { ip, kh: body.kh });
      const row = keys.getKeyByHash(String(body.kh || ''), scriptId);
      return JSON.stringify({
        success: true,
        nonce: s.nonce,
        salt: s.salt,
        ttl: s.ttl,
        server_proof: row
          ? serverProof({ key: row.value, nonce: s.nonce, salt: s.salt, scriptId })
          : 'de00'.repeat(16),
      });
    }

    if (url.endsWith('/api/v1/auth')) {
      const spent = nonce.consume(String(body.nonce || ''), {
        scriptId: String(body.script_id),
        ip,
        kh: String(body.kh || ''),
      });
      if (!spent.ok) return JSON.stringify({ success: false, message: 'Invalid or expired session' });

      const row = keys.getKeyByHash(String(body.kh || ''), String(body.script_id));
      if (!row) return JSON.stringify({ success: false, message: 'Invalid key' });

      const expected = clientProof({
        key: row.value,
        nonce: String(body.nonce),
        scriptId: String(body.script_id),
        hwid: body.hwid,
        executor: body.executor,
      });
      if (body.proof !== expected) {
        return JSON.stringify({ success: false, message: 'Session verification failed' });
      }

      const result = authenticate({
        scriptId: String(body.script_id),
        key: row.value,
        hwid: body.hwid || null,
        ip,
        executor: body.executor || null,
        session: { salt: spent.salt, nonce: String(body.nonce) },
      });
      if (result.success) {
        result.resp_proof = responseProof({
          key: row.value,
          nonce: String(body.nonce),
          enc: result.enc,
          lease: result.lease,
          script: result.script,
        });
      }
      return JSON.stringify(result);
    }

    if (url.endsWith('/api/v1/heartbeat')) {
      const rec = lease.get(String(body.lease || ''));
      if (!rec) return JSON.stringify({ success: false, revoked: true, message: 'Session ended' });

      const row = keys.getKeyById(rec.keyId);
      if (!row || row.status !== 'active') {
        return JSON.stringify({ success: false, revoked: true, message: 'Key is no longer valid' });
      }
      const expected = beatProof({ key: row.value, lease: String(body.lease), n: Number(body.n) });
      if (body.beat !== expected) return JSON.stringify({ success: false, message: 'Bad heartbeat' });

      const ok = lease.beat(String(body.lease), Number(body.n));
      if (!ok.ok) return JSON.stringify({ success: false, revoked: true, message: 'Session ended' });
      return JSON.stringify({ success: true, beat_every: 60 });
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
 * @returns {{warnings:string[], result:number|undefined, globals:(name:string)=>any,
 *            reports:object[], seen:object[]}}
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
  boot(HARNESS_LUA, 'harness');
  if (globals) boot(globals, 'globals');
  boot(loaderLua, 'loader');

  /** Read a global the protected script may have set. */
  const readGlobal = (name) => {
    lua.lua_getglobal(L, to_luastring(name));
    const v = lua.lua_isnil(L, -1) ? undefined : lua.lua_tonumber(L, -1);
    lua.lua_pop(L, 1);
    return v;
  };

  /**
   * Run the loader's heartbeat loop. The shim captures it instead of scheduling
   * it (see roblox_shim.lua), so a test drives it deliberately; it returns when
   * the server revokes the session or the shim's turn limit trips.
   */
  const beat = () => {
    lua.lua_getglobal(L, to_luastring('__BEAT'));
    if (lua.lua_isnil(L, -1)) {
      lua.lua_pop(L, 1);
      return false;
    }
    lua.lua_pcall(L, 0, 0, 0); // errors are the turn limit; the assertions judge the outcome
    return true;
  };

  return {
    warnings,
    result: readGlobal('__R'),
    globals: readGlobal,
    beat,
    reports: server.reports,
    seen: server.seen,
  };
}

module.exports = { makeServer, runLoader, decryptStub, fengari, CLIENT_IP };
