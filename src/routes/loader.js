'use strict';

const express = require('express');
const config = require('../config');
const scripts = require('../services/scripts');
const { authenticate, reportTamper } = require('../services/auth');
const nonce = require('../services/nonce');
const { renderLoader } = require('../services/bootstrap');
const { sessionProof, safeEqual } = require('../utils/crypto');
const { authLimiter, reportLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// Public endpoints only ever receive tiny JSON payloads (ids/keys/hwid), so cap
// them hard. There is no global body parser (see src/index.js) — parse here.
const jsonPublic = express.json({ limit: '16kb' });

// Longest values a genuine loader ever sends. Anything past this is junk or an
// attempt to make us hash/store something huge.
const MAX_KEY_LEN = 128;
const MAX_HWID_LEN = 256;
const MAX_EXEC_LEN = 256;

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
router.get('/loader/:file', (req, res) => {
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
 * Public (rate limited). The loader calls this first to open a session: it gets
 * a single-use nonce plus a salt it must prove possession of at /api/v1/auth.
 */
router.post('/api/v1/handshake', authLimiter, jsonPublic, (req, res) => {
  const { script_id } = req.body || {};
  if (!script_id) return res.status(400).json({ success: false, message: 'script_id is required' });
  const script = scripts.getScript(String(script_id));
  if (!script) return res.status(404).json({ success: false, message: 'Script not found' });
  if (!script.enabled) return res.status(503).json({ success: false, message: 'This script is temporarily disabled' });

  const session = nonce.issue(script.id, { ip: clientIp(req) });
  res.json({ success: true, nonce: session.nonce, salt: session.salt, ttl: session.ttl });
});

/**
 * POST /api/v1/auth
 * Public (rate limited). The loader calls this with
 * { script_id, key, hwid, executor, nonce, proof }.
 * On success responds { success:true, script:"<lua>", enc?:"session" }.
 */
router.post('/api/v1/auth', authLimiter, jsonPublic, (req, res) => {
  const body = req.body || {};
  if (!body.script_id || !body.key) {
    return res.status(400).json({ success: false, message: 'script_id and key are required' });
  }

  const scriptId = String(body.script_id);
  const key = field(body.key, MAX_KEY_LEN);
  const hwid = field(body.hwid, MAX_HWID_LEN);
  const executor = field(body.executor, MAX_EXEC_LEN);
  if (key === null || hwid === null || executor === null) {
    return res.status(400).json({ success: false, message: 'Malformed request' });
  }

  const ip = clientIp(req);
  let session = null;

  if (config.antiTamper) {
    // Anti-tamper: spend the handshake. Single-use, script-bound, IP-bound and
    // short-lived, so a captured auth request can't simply be sent again.
    const spent = nonce.consume(String(body.nonce || ''), { scriptId, ip });
    if (!spent.ok) {
      return res.status(401).json({ success: false, message: 'Invalid or expired session — please retry' });
    }

    // …and prove the caller actually holds this session's salt, over the exact
    // request being made. Editing any field of a captured request invalidates it.
    if (config.requireProof) {
      const expected = sessionProof({
        salt: spent.salt,
        nonce: String(body.nonce),
        scriptId,
        key,
        hwid,
        executor,
      });
      if (!safeEqual(String(body.proof || ''), expected)) {
        return res.status(401).json({ success: false, message: 'Session verification failed' });
      }
    }
    session = { salt: spent.salt, nonce: String(body.nonce) };
  }

  const result = authenticate({ scriptId, key, hwid: hwid || null, ip, executor: executor || null, session });

  const { code, ...payload } = result;
  res.status(result.success ? 200 : code || 400).json(payload);
});

/**
 * POST /api/v1/report
 * Public (tightly rate limited). The loader posts here when a client-side
 * integrity check trips. Advisory only: the report is forgeable, so it is
 * recorded for the dashboard but never grants anything.
 */
router.post('/api/v1/report', reportLimiter, jsonPublic, (req, res) => {
  if (!config.tamperReports) return res.status(404).json({ success: false, message: 'Not found' });

  const body = req.body || {};
  if (!body.script_id) return res.status(400).json({ success: false, message: 'script_id is required' });

  const key = field(body.key, MAX_KEY_LEN);
  const hwid = field(body.hwid, MAX_HWID_LEN);
  const executor = field(body.executor, MAX_EXEC_LEN);
  if (key === null || hwid === null || executor === null) {
    return res.status(400).json({ success: false, message: 'Malformed request' });
  }

  const result = reportTamper({
    scriptId: String(body.script_id),
    key,
    hwid,
    executor,
    ip: clientIp(req),
    reason: body.reason,
  });
  const { code, ...payload } = result;
  res.status(result.success ? 202 : code || 400).json(payload);
});

module.exports = router;
