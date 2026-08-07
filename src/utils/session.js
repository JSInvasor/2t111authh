'use strict';

const crypto = require('crypto');
const config = require('../config');

// Lightweight signed session tokens (JWT-like, HMAC-SHA256) — no deps.
// token = base64url(payload) + "." + base64url(HMAC(payloadPart))

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function sign(payloadPart) {
  return b64url(crypto.createHmac('sha256', config.sessionSecret).update(payloadPart).digest());
}

/**
 * @param {{role?:string, rid?:number|null, tv?:number, maxAgeMs?:number}} [opts]
 *   tv — the account's token_version at issue time. Checked against the database
 *   on every request, so a password change retires the tokens that predate it.
 */
function createToken(username, { role = 'admin', rid = null, tv = 0, maxAgeMs = config.sessionMaxAgeMs } = {}) {
  const payload = { u: username, role, tv, exp: Date.now() + maxAgeMs };
  if (rid != null) payload.rid = rid;
  const payloadPart = b64url(JSON.stringify(payload));
  return `${payloadPart}.${sign(payloadPart)}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const [payloadPart, sig] = token.split('.');
  if (!payloadPart || !sig) return null;

  const a = Buffer.from(sig);
  const b = Buffer.from(sign(payloadPart));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(fromB64url(payloadPart).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.u !== 'string' || typeof payload.exp !== 'number') return null;
  if (Date.now() > payload.exp) return null;
  return payload;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k) out[k] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token) {
  const parts = [
    `${config.cookieName}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${Math.floor(config.sessionMaxAgeMs / 1000)}`,
  ];
  if (config.cookieSecure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  const parts = [`${config.cookieName}=`, 'HttpOnly', 'Path=/', 'SameSite=Strict', 'Max-Age=0'];
  if (config.cookieSecure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

module.exports = { createToken, verifyToken, parseCookies, setSessionCookie, clearSessionCookie };
