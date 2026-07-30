'use strict';

const config = require('../config');
const { safeEqual } = require('../utils/crypto');
const { parseCookies, verifyToken } = require('../utils/session');
const resellers = require('../services/resellers');

/**
 * Resolve the caller's identity from EITHER:
 *   1. Authorization: Bearer <ADMIN_API_KEY>  (always admin)
 *   2. A dashboard session cookie (role from the token; defaults to admin)
 * Returns { role, username, resellerId } or null.
 */
function resolve(req) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim();
  if (config.adminApiKey && token && safeEqual(token, config.adminApiKey)) {
    return { role: 'admin', username: 'apikey', resellerId: null };
  }
  const payload = verifyToken(parseCookies(req)[config.cookieName]);
  if (payload) return { role: payload.role || 'admin', username: payload.u, resellerId: payload.rid || null };
  return null;
}

function requireAdmin(req, res, next) {
  const auth = resolve(req);
  if (!auth) return res.status(401).json({ success: false, message: 'Unauthorized' });
  if (auth.role !== 'admin') return res.status(403).json({ success: false, message: 'Admins only' });
  req.auth = auth;
  next();
}

function requireReseller(req, res, next) {
  const auth = resolve(req);
  if (!auth) return res.status(401).json({ success: false, message: 'Unauthorized' });
  if (auth.role !== 'reseller') return res.status(403).json({ success: false, message: 'Resellers only' });
  const reseller = resellers.getById(auth.resellerId);
  if (!reseller || !reseller.enabled) {
    return res.status(403).json({ success: false, message: 'Reseller account is disabled' });
  }
  req.auth = auth;
  req.reseller = reseller;
  next();
}

module.exports = { resolve, requireAdmin, requireReseller };
