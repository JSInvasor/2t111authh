'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const admins = require('../services/admins');
const resellers = require('../services/resellers');
const {
  createToken,
  verifyToken,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
} = require('../utils/session');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts, try again later.' },
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'username and password are required' });
    }
    const u = String(username);
    const p = String(password);

    // Admins are checked first (they win a username clash). The token carries the
    // account's current token_version, so a later password change retires it.
    const admin = await admins.verifyLogin(u, p);
    if (admin) {
      setSessionCookie(res, createToken(u, { role: 'admin', tv: admin.token_version }));
      return res.json({ success: true, username: u, role: 'admin' });
    }

    const r = await resellers.verifyLogin(u, p);
    if (r) {
      if (!r.enabled) return res.status(403).json({ success: false, message: 'Account is disabled' });
      setSessionCookie(res, createToken(u, { role: 'reseller', rid: r.id, tv: r.token_version }));
      return res.json({ success: true, username: u, role: 'reseller' });
    }

    res.status(401).json({ success: false, message: 'Invalid credentials' });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

router.get('/me', (req, res) => {
  const payload = verifyToken(parseCookies(req)[config.cookieName]);
  if (!payload) return res.status(401).json({ success: false });
  const role = payload.role || 'admin';
  const out = { success: true, username: payload.u, role };

  // Same staleness check the API middleware applies, so the dashboard signs the
  // user out rather than rendering a shell whose every request will 401.
  const account = role === 'reseller' ? resellers.getByUsername(payload.u) : admins.getAdmin(payload.u);
  if (!account || typeof payload.tv !== 'number' || payload.tv !== account.token_version) {
    return res.status(401).json({ success: false });
  }

  if (role === 'reseller') {
    const r = resellers.getById(payload.rid);
    if (!r || !r.enabled) return res.status(401).json({ success: false });
    out.credits = r.credits;
  }
  res.json(out);
});

module.exports = router;
