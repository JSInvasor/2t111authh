'use strict';

// Reseller-scoped API (mounted behind requireReseller). A reseller can only:
//  - see their assigned scripts (no source code)
//  - generate keys for those scripts (spending credits)
//  - manage keys they created

const express = require('express');
const config = require('../config');
const db = require('../db');
const scripts = require('../services/scripts');
const keys = require('../services/keys');
const resellers = require('../services/resellers');
const audit = require('../services/audit');

const router = express.Router();

/** Thrown inside the credit transaction to roll it back with a 402, not a 500. */
class InsufficientCredits extends Error {
  constructor(needed) {
    super(`Not enough credits (need ${needed})`);
    this.needed = needed;
  }
}

function loaderSnippet(scriptId) {
  return `script_key = "YOUR_KEY_HERE";\nloadstring(game:HttpGet("${config.baseUrl}/loader/${scriptId}.lua"))()`;
}

// Ensure a key exists AND belongs to the calling reseller.
function ownKey(req, res) {
  const id = parseInt(req.params.id, 10);
  const key = keys.getKeyById(id);
  if (!key || key.reseller_id !== req.reseller.id) {
    res.status(404).json({ success: false, message: 'Not found' });
    return null;
  }
  return key;
}

router.get('/me', (req, res) => {
  const r = req.reseller;
  res.json({
    success: true,
    username: r.username,
    credits: r.credits,
    scripts: resellers.scriptsFor(r.id),
  });
});

router.get('/keys', (req, res) => {
  const scriptId = req.query.script_id ? String(req.query.script_id) : null;
  if (scriptId && !resellers.hasScript(req.reseller.id, scriptId)) {
    return res.status(403).json({ success: false, message: 'You are not assigned to this script' });
  }
  res.json({ success: true, keys: keys.listKeysByReseller(req.reseller.id, { scriptId }) });
});

router.post('/keys', (req, res) => {
  const { script_id, count, expiresInDays, note } = req.body || {};
  if (!script_id) return res.status(400).json({ success: false, message: 'script_id is required' });
  const scriptId = String(script_id);
  if (!resellers.hasScript(req.reseller.id, scriptId)) {
    return res.status(403).json({ success: false, message: 'You are not assigned to this script' });
  }
  if (!scripts.getScript(scriptId)) return res.status(404).json({ success: false, message: 'Script not found' });

  const n = Math.max(1, Math.min(parseInt(count, 10) || 1, 1000));

  // 1 credit per key. Debit and mint in ONE transaction: these used to be two,
  // so any failure inside createKeys (a unique-collision retry giving up, a busy
  // timeout, a full disk) left the reseller charged for keys they never got.
  let created;
  try {
    created = db.transaction(() => {
      if (!resellers.spendCredits(req.reseller.id, n)) throw new InsufficientCredits(n);
      return keys.createKeys(scriptId, {
        count: n,
        expiresInDays: expiresInDays > 0 ? expiresInDays : null,
        note: note || '',
        resellerId: req.reseller.id,
        actor: audit.actorFromRequest(req),
      });
    })();
  } catch (err) {
    if (err instanceof InsufficientCredits) {
      return res.status(402).json({ success: false, message: `Not enough credits (need ${n})` });
    }
    throw err;
  }

  res.status(201).json({
    success: true,
    keys: created,
    credits: resellers.getById(req.reseller.id).credits,
    loader: loaderSnippet(scriptId),
  });
});

router.patch('/keys/:id', (req, res) => {
  const key = ownKey(req, res);
  if (!key) return;
  const body = req.body || {};
  const fields = {};
  if ('status' in body && ['active', 'banned', 'paused'].includes(body.status)) fields.status = body.status;
  if ('note' in body) fields.note = body.note;
  res.json({ success: true, key: keys.updateKey(key.id, fields, { actor: audit.actorFromRequest(req) }) });
});

for (const [path, status] of [
  ['/keys/:id/ban', 'banned'],
  ['/keys/:id/unban', 'active'],
  ['/keys/:id/pause', 'paused'],
]) {
  router.post(path, (req, res) => {
    const key = ownKey(req, res);
    if (!key) return;
    res.json({ success: true, key: keys.updateKey(key.id, { status }, { actor: audit.actorFromRequest(req) }) });
  });
}

router.post('/keys/:id/reset-hwid', (req, res) => {
  const key = ownKey(req, res);
  if (!key) return;
  res.json({ success: true, key: keys.resetHwid(key.id, { actor: audit.actorFromRequest(req) }) });
});

router.delete('/keys/:id', (req, res) => {
  const key = ownKey(req, res);
  if (!key) return;
  res.json({ success: keys.deleteKey(key.id, { actor: audit.actorFromRequest(req) }) });
});

module.exports = router;
