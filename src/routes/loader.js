'use strict';

const express = require('express');
const config = require('../config');
const scripts = require('../services/scripts');
const keys = require('../services/keys');
const { authenticate, reportTamper } = require('../services/auth');
const nonce = require('../services/nonce');
const { renderLoader } = require('../services/bootstrap');
const {
  serverProof,
  decoyServerProof,
  clientProof,
  reportProof,
  responseProof,
  safeEqual,
} = require('../utils/crypto');
const { authLimiter, loaderLimiter, reportLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// Public endpoints only ever receive tiny JSON payloads (ids/keys/hwid), so cap
// them hard. There is no global body parser (see src/index.js) — parse here.
const jsonPublic = express.json({ limit: '16kb' });

// Longest values a genuine loader ever sends. Anything past this is junk or an
// attempt to make us hash/store something huge.
const MAX_HWID_LEN = 256;
const MAX_EXEC_LEN = 256;
// keyHash() output: 64 lowercase hex chars, exactly.
const KH_RE = /^[0-9a-f]{64}$/;

/**
 * The caller's address. `req.ip` honours the configured `trust proxy` depth, so
 * it can't be forged by stuffing X-Forwarded-For — reading that header directly
 * would hand any client a free IP of its choosing.
 */
function clientIp(req) {
  const ip = req.ip || req.socket.remoteAddress || null;
  // Normalise IPv4-mapped IPv6 so an address is spelled the same way everywhere.
  return ip ? String(ip).replace(/^::ffff:/, '') : null;
}

/** Field a genuine loader sends: a string within its length budget. */
function field(value, max) {
  if (value == null) return '';
  const s = String(value);
  return s.length > max ? null : s;
}

/**
 * GET /loader/:scriptId.lua
 * Public. Returns the Lua bootstrap that collects HWID, runs the handshake and
 * calls /api/v1/auth. This is what end users load:
 *   script_key = "..."; loadstring(game:HttpGet(".../loader/<id>.lua"))()
 */
router.get('/loader/:file', loaderLimiter, (req, res) => {
  const script = scripts.getScript(req.params.file.replace(/\.lua$/i, ''));
  res.type('text/plain');
  // Every delivery is unique (fresh identifiers/cipher key) — never let a proxy
  // hand the same bytes to the next caller.
  res.set('Cache-Control', 'no-store');
  if (!script) return res.status(404).send('-- [2t1auth] script not found');
  res.send(renderLoader(script));
});

/**
 * POST /api/v1/handshake
 * Public (rate limited). Opens a session. The loader names its key by hash
 * (never the key itself) and gets back a single-use nonce, a salt, and a
 * `server_proof` HMAC'd under that key.
 *
 * The proof is the half of the protocol the server owes the client: only
 * something holding the real key can produce it, so the loader can tell this
 * server apart from anything else that happens to answer the URL. It verifies
 * the proof BEFORE sending its own, so a hostile endpoint learns nothing.
 *
 * An unknown kh gets a decoy proof rather than an error, so the shape of the
 * response never reveals whether a key exists.
 */
router.post('/api/v1/handshake', authLimiter, jsonPublic, (req, res) => {
  const { script_id, kh } = req.body || {};
  if (!script_id) return res.status(400).json({ success: false, message: 'script_id is required' });
  const script = scripts.getScript(String(script_id));
  if (!script) return res.status(404).json({ success: false, message: 'Script not found' });
  if (!script.enabled) return res.status(503).json({ success: false, message: 'This script is temporarily disabled' });

  const keyHashHex = typeof kh === 'string' && KH_RE.test(kh) ? kh : null;
  if (!keyHashHex) return res.status(400).json({ success: false, message: 'kh is required' });

  const session = nonce.issue(script.id, { ip: clientIp(req), kh: keyHashHex });
  const row = keys.getKeyByHash(keyHashHex, script.id);

  res.json({
    success: true,
    nonce: session.nonce,
    salt: session.salt,
    ttl: session.ttl,
    server_proof: row
      ? serverProof({ key: row.value, nonce: session.nonce, salt: session.salt, scriptId: script.id })
      : decoyServerProof(keyHashHex),
  });
});

/**
 * POST /api/v1/auth
 * Public (rate limited). The loader calls this with
 * { script_id, kh, hwid, executor, nonce, proof } — note there is no `key`
 * field: the key is named by hash and proven by HMAC, never transmitted.
 * On success responds { success:true, script:"<lua>", enc?:"session", resp_proof }.
 */
router.post('/api/v1/auth', authLimiter, jsonPublic, (req, res) => {
  const body = req.body || {};
  if (!body.script_id || !body.kh) {
    return res.status(400).json({ success: false, message: 'script_id and kh are required' });
  }

  const scriptId = String(body.script_id);
  const kh = String(body.kh);
  const hwid = field(body.hwid, MAX_HWID_LEN);
  const executor = field(body.executor, MAX_EXEC_LEN);
  if (!KH_RE.test(kh) || hwid === null || executor === null) {
    return res.status(400).json({ success: false, message: 'Malformed request' });
  }

  const ip = clientIp(req);
  let session = null;

  if (config.antiTamper) {
    // Spend the handshake. Single-use, script-bound, key-bound, IP-bound and
    // short-lived, so a captured auth request can't simply be sent again.
    const spent = nonce.consume(String(body.nonce || ''), { scriptId, ip, kh });
    if (!spent.ok) {
      return res.status(401).json({ success: false, message: 'Invalid or expired session — please retry' });
    }
    session = { salt: spent.salt, nonce: String(body.nonce) };
  }

  // Resolve the key by hash. Everything past this point needs the key value to
  // check the caller's proof and to sign what we send back.
  const row = keys.getKeyByHash(kh, scriptId);

  // Prove the caller actually holds the key, over the exact request being made.
  // Editing any field of a captured request invalidates it. Unknown keys fall
  // through to authenticate() so the "invalid key" answer stays uniform.
  if (config.antiTamper && config.requireProof && row) {
    const expected = clientProof({ key: row.value, nonce: String(body.nonce), scriptId, hwid, executor });
    if (!safeEqual(String(body.proof || ''), expected)) {
      return res.status(401).json({ success: false, message: 'Session verification failed' });
    }
  }

  const result = authenticate({
    scriptId,
    key: row ? row.value : null,
    hwid: hwid || null,
    ip,
    executor: executor || null,
    session,
  });

  const { code, ...payload } = result;
  // Sign the response under the key. This covers `enc` as well as the payload,
  // so a response cannot be swapped, edited, or downgraded from session-encrypted
  // to plaintext by anything sitting between us and the executor.
  if (result.success && row) {
    payload.resp_proof = responseProof({
      key: row.value,
      nonce: session ? session.nonce : '',
      enc: payload.enc,
      script: payload.script,
    });
  }
  res.status(result.success ? 200 : code || 400).json(payload);
});

/**
 * POST /api/v1/report
 * Public (tightly rate limited). The loader posts here when a client-side
 * integrity check trips, over its own handshake.
 *
 * The session proof is required because a report can count toward an auto-ban
 * (TAMPER_REPORT_BAN): unauthenticated, this endpoint let anyone who knew a key's
 * value ban that key at will. Proving key possession makes the report cost the
 * attacker the very thing they were trying to attack.
 */
router.post('/api/v1/report', reportLimiter, jsonPublic, (req, res) => {
  if (!config.tamperReports) return res.status(404).json({ success: false, message: 'Not found' });

  const body = req.body || {};
  if (!body.script_id) return res.status(400).json({ success: false, message: 'script_id is required' });

  const scriptId = String(body.script_id);
  const kh = String(body.kh || '');
  const hwid = field(body.hwid, MAX_HWID_LEN);
  const executor = field(body.executor, MAX_EXEC_LEN);
  const reason = field(body.reason, MAX_EXEC_LEN);
  if (!KH_RE.test(kh) || hwid === null || executor === null || reason === null) {
    return res.status(400).json({ success: false, message: 'Malformed request' });
  }

  // Spend a handshake and prove key possession. Failures answer 202 like a
  // success would, so an unauthenticated caller learns nothing about which keys
  // exist and cannot tell a rejected report from an accepted one.
  const accepted = { success: true };
  const spent = nonce.consume(String(body.nonce || ''), { scriptId, ip: clientIp(req), kh });
  if (!spent.ok) return res.status(202).json(accepted);

  const row = keys.getKeyByHash(kh, scriptId);
  if (!row) return res.status(202).json(accepted);

  const expected = reportProof({ key: row.value, nonce: String(body.nonce), scriptId, reason });
  if (!safeEqual(String(body.proof || ''), expected)) return res.status(202).json(accepted);

  const result = reportTamper({
    scriptId,
    keyRow: row,
    hwid,
    executor,
    ip: clientIp(req),
    reason,
  });
  const { code, ...payload } = result;
  res.status(result.success ? 202 : code || 400).json(payload);
});

module.exports = router;
