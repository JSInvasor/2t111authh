'use strict';

const express = require('express');
const keys = require('../services/keys');
const audit = require('../services/audit');

const router = express.Router();

const VALID_STATUS = new Set(['active', 'banned', 'paused']);

// Look up a key by its value (e.g. to inspect from a Discord bot later).
router.get('/:value', (req, res) => {
  const key = keys.getKeyByValue(req.params.value);
  if (!key) return res.status(404).json({ success: false, message: 'Not found' });
  res.json({ success: true, key });
});

// Update a key by numeric id (status / note / expiry / discord_id / hwid).
router.patch('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const key = keys.getKeyById(id);
  if (!key) return res.status(404).json({ success: false, message: 'Not found' });

  const fields = req.body || {};
  if ('status' in fields && !VALID_STATUS.has(fields.status)) {
    return res.status(400).json({ success: false, message: 'status must be active | banned | paused' });
  }
  res.json({ success: true, key: keys.updateKey(id, fields, { actor: audit.actorFromRequest(req) }) });
});

// Convenience status shortcuts.
for (const [path, status] of [
  ['/:id/ban', 'banned'],
  ['/:id/unban', 'active'],
  ['/:id/pause', 'paused'],
]) {
  router.post(path, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!keys.getKeyById(id)) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, key: keys.updateKey(id, { status }, { actor: audit.actorFromRequest(req) }) });
  });
}

// Reset (unbind) the HWID of a key.
router.post('/:id/reset-hwid', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!keys.getKeyById(id)) return res.status(404).json({ success: false, message: 'Not found' });
  res.json({ success: true, key: keys.resetHwid(id, { actor: audit.actorFromRequest(req) }) });
});

router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  res.json({ success: keys.deleteKey(id, { actor: audit.actorFromRequest(req) }) });
});

module.exports = router;
