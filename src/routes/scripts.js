'use strict';

const express = require('express');
const config = require('../config');
const scripts = require('../services/scripts');
const keys = require('../services/keys');
const { scriptStats } = require('../services/stats');

const router = express.Router();

function loaderSnippet(scriptId) {
  return (
    `script_key = "YOUR_KEY_HERE";\n` +
    `loadstring(game:HttpGet("${config.baseUrl}/loader/${scriptId}.lua"))()`
  );
}

// ---- scripts / projects ----

router.post('/', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ success: false, message: 'name is required' });
  const script = scripts.createScript({
    name: b.name,
    source: b.source,
    version: b.version,
    hwid_lock: b.hwid_lock,
    hwid_reset_cooldown: b.hwid_reset_cooldown,
    hwid_reset_limit: b.hwid_reset_limit,
    obfuscate: b.obfuscate,
    enabled: b.enabled,
  });
  res.status(201).json({ success: true, script, loader: loaderSnippet(script.id) });
});

router.get('/', (req, res) => {
  res.json({ success: true, scripts: scripts.listScripts() });
});

router.get('/:id', (req, res) => {
  const script = scripts.getScript(req.params.id);
  if (!script) return res.status(404).json({ success: false, message: 'Not found' });
  res.json({ success: true, script, loader: loaderSnippet(script.id) });
});

router.patch('/:id', (req, res) => {
  const script = scripts.getScript(req.params.id);
  if (!script) return res.status(404).json({ success: false, message: 'Not found' });
  res.json({ success: true, script: scripts.updateScript(req.params.id, req.body || {}) });
});

router.delete('/:id', (req, res) => {
  res.json({ success: scripts.deleteScript(req.params.id) });
});

// ---- keys belonging to a script ----

router.post('/:id/keys', (req, res) => {
  const script = scripts.getScript(req.params.id);
  if (!script) return res.status(404).json({ success: false, message: 'Script not found' });
  const { count, expiresInDays, note, discordId } = req.body || {};
  const created = keys.createKeys(req.params.id, { count, expiresInDays, note, discordId });
  res.status(201).json({ success: true, count: created.length, keys: created });
});

router.get('/:id/keys', (req, res) => {
  const script = scripts.getScript(req.params.id);
  if (!script) return res.status(404).json({ success: false, message: 'Not found' });
  const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 1000);
  const offset = parseInt(req.query.offset || '0', 10) || 0;
  res.json({ success: true, keys: keys.listKeys(req.params.id, { limit, offset }) });
});

// Export all keys of a script as CSV.
router.get('/:id/keys.csv', (req, res) => {
  const script = scripts.getScript(req.params.id);
  if (!script) return res.status(404).json({ success: false, message: 'Not found' });

  const cols = ['value', 'status', 'hwid', 'note', 'discord_id', 'expires_at', 'total_executions', 'last_seen', 'created_at'];
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = keys.listKeys(req.params.id, { limit: 100000, offset: 0 });
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');

  const safeName = String(script.name).replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40) || 'keys';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}_keys.csv"`);
  res.send(csv);
});

// ---- analytics ----

router.get('/:id/stats', (req, res) => {
  const script = scripts.getScript(req.params.id);
  if (!script) return res.status(404).json({ success: false, message: 'Not found' });
  const days = Math.min(parseInt(req.query.days || '7', 10) || 7, 365);
  res.json({ success: true, stats: scriptStats(req.params.id, { sinceDays: days }) });
});

module.exports = router;
