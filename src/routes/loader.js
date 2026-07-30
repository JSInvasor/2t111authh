'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const scripts = require('../services/scripts');
const { authenticate } = require('../services/auth');
const nonce = require('../services/nonce');
const { authLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// Public endpoints only ever receive tiny JSON payloads (ids/keys/hwid), so cap
// them hard. There is no global body parser (see src/index.js) — parse here.
const jsonPublic = express.json({ limit: '16kb' });

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', '..', 'lua', 'loader_template.lua'), 'utf8');

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || null;
}

/**
 * GET /loader/:scriptId.lua
 * Public. Returns the Lua bootstrap that collects HWID and calls /api/v1/auth.
 * This is what end users load:
 *   script_key = "..."; loadstring(game:HttpGet(".../loader/<id>.lua"))()
 */
router.get('/loader/:file', (req, res) => {
  const scriptId = req.params.file.replace(/\.lua$/i, '');
  const script = scripts.getScript(scriptId);
  res.type('text/plain');
  if (!script) return res.status(404).send('-- [2t1auth] script not found');

  const lua = TEMPLATE.replace(/{{API_URL}}/g, config.baseUrl)
    .replace(/{{SCRIPT_ID}}/g, scriptId)
    .replace(/{{SCRIPT_NAME}}/g, String(script.name || '').replace(/[\r\n"]/g, ' '));
  res.send(lua);
});

/**
 * POST /api/v1/handshake
 * Public (rate limited). The loader calls this first to get a single-use nonce,
 * which it must then include in /api/v1/auth. Blocks trivial replay of auth requests.
 */
router.post('/api/v1/handshake', authLimiter, jsonPublic, (req, res) => {
  const { script_id } = req.body || {};
  if (!script_id) return res.status(400).json({ success: false, message: 'script_id is required' });
  const script = scripts.getScript(String(script_id));
  if (!script) return res.status(404).json({ success: false, message: 'Script not found' });
  if (!script.enabled) return res.status(503).json({ success: false, message: 'This script is temporarily disabled' });
  res.json({ success: true, nonce: nonce.issue(script.id) });
});

/**
 * POST /api/v1/auth
 * Public (rate limited). The loader calls this with { script_id, key, hwid, executor, nonce }.
 * On success responds { success:true, script:"<lua source>" }.
 */
router.post('/api/v1/auth', authLimiter, jsonPublic, (req, res) => {
  const { script_id, key, hwid, executor, nonce: n } = req.body || {};
  if (!script_id || !key) {
    return res.status(400).json({ success: false, message: 'script_id and key are required' });
  }

  // Anti-tamper: require a fresh, single-use nonce from the handshake.
  if (config.antiTamper && !nonce.consume(String(n || ''), String(script_id))) {
    return res.status(401).json({ success: false, message: 'Invalid or expired session — please retry' });
  }

  const result = authenticate({
    scriptId: String(script_id),
    key: String(key),
    hwid: hwid != null ? String(hwid) : null,
    ip: clientIp(req),
    executor: executor != null ? String(executor).slice(0, 64) : null,
  });

  const { code, ...payload } = result;
  res.status(result.success ? 200 : code || 400).json(payload);
});

module.exports = router;
