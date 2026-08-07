'use strict';

const config = require('../config');
const { safeEqual } = require('../utils/crypto');
const { parseCookies, verifyToken } = require('../utils/session');
const admins = require('../services/admins');
const resellers = require('../services/resellers');

/**
 * Resolve the caller's identity from EITHER:
 *   1. Authorization: Bearer <ADMIN_API_KEY>  (always admin)
 *   2. A dashboard session cookie (role from the token; defaults to admin)
 * Returns { role, username, resellerId, tokenVersion } or null.
 *
 * The signature and expiry are all this checks — whether the account still
 * exists, is still enabled, and still accepts this token's version is decided
 * per role below, against the database.
 */
function resolve(req) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim();
  if (config.adminApiKey && token && safeEqual(token, config.adminApiKey)) {
    return { role: 'admin', username: 'apikey', resellerId: null, tokenVersion: null, viaApiKey: true };
  }
  const payload = verifyToken(parseCookies(req)[config.cookieName]);
  if (payload) {
    return {
      role: payload.role || 'admin',
      username: payload.u,
      resellerId: payload.rid || null,
      tokenVersion: typeof payload.tv === 'number' ? payload.tv : null,
      viaApiKey: false,
    };
  }
  return null;
}

/**
 * A cookie is only good while the account behind it still exists and has not
 * changed its password since the token was minted. Previously an admin cookie
 * was never checked against the database at all: a valid signature was the whole
 * test, so a leaked cookie outlived any attempt to lock it out.
 */
function tokenStale(auth, row) {
  if (!row) return true;
  return auth.tokenVersion === null || auth.tokenVersion !== row.token_version;
}

function requireAdmin(req, res, next) {
  const auth = resolve(req);
  if (!auth) return res.status(401).json({ success: false, message: 'Unauthorized' });
  if (auth.role !== 'admin') return res.status(403).json({ success: false, message: 'Admins only' });
  if (!auth.viaApiKey && tokenStale(auth, admins.getAdmin(auth.username))) {
    return res.status(401).json({ success: false, message: 'Session expired — please sign in again' });
  }
  req.auth = auth;
  next();
}

/**
 * Managing admin accounts is owner-only. Every admin being able to mint more
 * admins would flatten the hierarchy into "everyone is root" — one compromised
 * account could quietly create its own way back in, and no account would be able
 * to shut it out again.
 *
 * The master ADMIN_API_KEY passes: it is the root credential and the recovery
 * path, so locking it out of admin management would make a lost owner password
 * a database-surgery problem.
 */
function requireOwner(req, res, next) {
  requireAdmin(req, res, () => {
    if (!req.auth.viaApiKey && !admins.isOwner(req.auth.username)) {
      return res.status(403).json({ success: false, message: 'Only the owner account can manage admins' });
    }
    next();
  });
}

function requireReseller(req, res, next) {
  const auth = resolve(req);
  if (!auth) return res.status(401).json({ success: false, message: 'Unauthorized' });
  if (auth.role !== 'reseller') return res.status(403).json({ success: false, message: 'Resellers only' });
  const reseller = resellers.getById(auth.resellerId);
  if (!reseller || !reseller.enabled) {
    return res.status(403).json({ success: false, message: 'Reseller account is disabled' });
  }
  if (tokenStale(auth, resellers.getByUsername(auth.username))) {
    return res.status(401).json({ success: false, message: 'Session expired — please sign in again' });
  }
  req.auth = auth;
  req.reseller = reseller;
  next();
}

module.exports = { resolve, requireAdmin, requireOwner, requireReseller };
