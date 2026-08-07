'use strict';

// Single-use, short-lived handshake sessions for the loader (replay protection).
//
// A handshake hands the loader a `nonce` plus a per-session `salt`. The salt is
// what turns the handshake from "a token you can just ask for again" into a real
// binding: the loader must prove it holds the salt (HMAC over the request), and
// the delivered payload is encrypted under a key derived from it. So a captured
// /api/v1/auth request can neither be replayed nor edited, and a captured
// response can't be decrypted outside the session that asked for it.
//
// In-memory store — only the API process issues and consumes these.

const crypto = require('crypto');
const config = require('../config');
const { netPrefix, sameNetwork } = require('../utils/net');

const store = new Map(); // nonce -> { scriptId, ip, kh, salt, expires }
// Exact address, deliberately: the per-host cap wants the FINEST granularity it
// can get, or every client behind one carrier NAT would share a single budget.
// The binding check below wants the opposite (see consume) — coarse enough to
// survive address churn. Both choices point the same way: don't punish someone
// for the address their carrier happened to give them.
const perIp = new Map(); // ip -> live nonce count

function bumpIp(ip, delta) {
  if (!ip) return;
  const next = (perIp.get(ip) || 0) + delta;
  if (next > 0) perIp.set(ip, next);
  else perIp.delete(ip);
}

function drop(nonce) {
  const rec = store.get(nonce);
  if (!rec) return false;
  store.delete(nonce);
  bumpIp(rec.ip, -1);
  return true;
}

/**
 * Issue a fresh handshake bound to a script, to the key it was opened for, and
 * (when enabled) to the caller's IP.
 * @param {string} scriptId
 * @param {{ip?:string|null, kh?:string|null}} [opts]
 *   kh — keyHash of the key this handshake is for. Recorded so /api/v1/auth can
 *   refuse a nonce that was opened under a different key.
 * @returns {{nonce:string, salt:string, ttl:number}}
 */
function issue(scriptId, { ip = null, kh = null } = {}) {
  sweep();

  const boundIp = config.nonceBindIp && ip ? String(ip) : null;

  // One IP may only hold so many un-spent handshakes at a time; retire its
  // oldest instead of letting a single host park entries until they expire.
  if (boundIp && (perIp.get(boundIp) || 0) >= config.nonceMaxPerIp) {
    for (const [k, v] of store) {
      if (v.ip === boundIp) {
        drop(k);
        break;
      }
    }
  }

  // Global ceiling. Map iterates in insertion order, so this evicts oldest-first.
  while (store.size >= config.nonceMax) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    drop(oldest);
  }

  const nonce = crypto.randomBytes(24).toString('base64url');
  const salt = crypto.randomBytes(24).toString('base64url');
  store.set(nonce, {
    scriptId: String(scriptId),
    ip: boundIp,
    kh: kh ? String(kh) : null,
    salt,
    expires: Date.now() + config.nonceTtlMs,
  });
  bumpIp(boundIp, 1);
  return { nonce, salt, ttl: config.nonceTtlMs };
}

/**
 * Spend a handshake. Always single-use: the record is removed on the first
 * attempt, valid or not, so a guessed/stolen nonce can't be retried.
 * @param {string} nonce
 * @param {{scriptId:string, ip?:string|null, kh?:string|null}} opts
 *   kh — when given, the handshake must have been opened for this same key.
 * @returns {{ok:true, salt:string, kh:string|null} | {ok:false, reason:string}}
 */
function consume(nonce, { scriptId, ip = null, kh = null } = {}) {
  const rec = store.get(String(nonce || ''));
  if (!rec) return { ok: false, reason: 'unknown_nonce' };
  drop(String(nonce));

  if (rec.expires < Date.now()) return { ok: false, reason: 'expired_nonce' };
  if (rec.scriptId !== String(scriptId)) return { ok: false, reason: 'nonce_script_mismatch' };
  // Same network, not same address — see utils/net.js. An exact match locked out
  // every phone that changed cell or carrier NAT between the two requests.
  if (rec.ip && !sameNetwork(ip, rec.ip)) return { ok: false, reason: 'nonce_ip_mismatch' };
  // A handshake opened for one key may not be spent for another, so a nonce
  // harvested while probing with a key you own can't be used to carry someone
  // else's key through.
  if (kh !== null && rec.kh !== null && rec.kh !== String(kh)) {
    return { ok: false, reason: 'nonce_key_mismatch' };
  }
  return { ok: true, salt: rec.salt, kh: rec.kh };
}

function sweep() {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expires < now) drop(k);
  }
}

/** Snapshot for health/diagnostics. */
function stats() {
  return { live: store.size, ips: perIp.size, max: config.nonceMax };
}

/** Test helper — drop every live handshake. */
function reset() {
  store.clear();
  perIp.clear();
}

// Periodic cleanup. Clamped so a long NONCE_TTL_MS can't stall the sweeper (and
// a tiny one can't spin it); unref'd so it never keeps the process alive.
const timer = setInterval(sweep, Math.min(60000, Math.max(5000, config.nonceTtlMs)));
if (timer.unref) timer.unref();

module.exports = { issue, consume, sweep, stats, reset, _store: store };
