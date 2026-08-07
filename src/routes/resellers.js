'use strict';

// Admin-only reseller management (mounted behind requireAdmin).

const express = require('express');
const resellers = require('../services/resellers');
const admins = require('../services/admins');
const scripts = require('../services/scripts');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ success: true, resellers: resellers.list() });
});

router.post('/', async (req, res, next) => {
  try {
    const { username, password, credits } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'username and password are required' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ success: false, message: 'password must be at least 6 characters' });
    }
    if (resellers.getByUsername(String(username)) || admins.getAdmin(String(username))) {
      return res.status(409).json({ success: false, message: 'That username is taken' });
    }
    const reseller = await resellers.create({ username: String(username), password: String(password), credits });
    res.status(201).json({ success: true, reseller });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', (req, res) => {
  const reseller = resellers.getById(parseInt(req.params.id, 10));
  if (!reseller) return res.status(404).json({ success: false, message: 'Not found' });
  res.json({ success: true, reseller, scripts: resellers.scriptsFor(reseller.id) });
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!resellers.getById(id)) return res.status(404).json({ success: false, message: 'Not found' });
    const body = req.body || {};
    if ('enabled' in body) resellers.setEnabled(id, body.enabled);
    if (body.password) {
      if (String(body.password).length < 6) {
        return res.status(400).json({ success: false, message: 'password must be at least 6 characters' });
      }
      await resellers.setPassword(id, String(body.password));
    }
    res.json({ success: true, reseller: resellers.getById(id) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/credits', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!resellers.getById(id)) return res.status(404).json({ success: false, message: 'Not found' });
  const amount = parseInt((req.body || {}).amount, 10) || 0;
  res.json({ success: true, reseller: resellers.addCredits(id, amount) });
});

router.post('/:id/scripts', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!resellers.getById(id)) return res.status(404).json({ success: false, message: 'Not found' });
  const scriptId = String((req.body || {}).script_id || '');
  if (!scripts.getScript(scriptId)) return res.status(404).json({ success: false, message: 'Script not found' });
  resellers.assignScript(id, scriptId);
  res.json({ success: true, scripts: resellers.scriptsFor(id) });
});

router.delete('/:id/scripts/:scriptId', (req, res) => {
  const id = parseInt(req.params.id, 10);
  resellers.unassignScript(id, req.params.scriptId);
  res.json({ success: true, scripts: resellers.scriptsFor(id) });
});

router.delete('/:id', (req, res) => {
  res.json({ success: resellers.remove(parseInt(req.params.id, 10)) });
});

module.exports = router;
