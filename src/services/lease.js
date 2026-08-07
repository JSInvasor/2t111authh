'use strict';

// Live sessions.
//
// Auth used to be one-shot: prove yourself once, receive the script, and you
// were never heard from again. Banning a key stopped the NEXT auth and did
// nothing to the copy already running, and "is this key being shared?" could
// only be guessed at afterwards by counting distinct HWIDs in the log — which
// flags a user who switched from wifi to mobile data just as readily as it
// flags two people on one key.
//
// A lease turns that into an ongoing relationship. A successful auth opens one;
// the loader beats against it on an interval; the server answers "keep going"
// or "you're revoked". That gives two things the log never could:
//
//   • revocation that reaches a session already in flight, and
//   • concurrency as a sharing signal — two live leases on one key is one
//     account in two places right now, not a statistical guess about the past.
//
// Beats are HMAC'd under the license key and carry a strictly increasing
// counter, so a captured beat is neither forgeable nor replayable.
//
// In-memory, like the handshake store: only the API process issues these.

const crypto = require('crypto');
const config = require('../config');

const store = new Map(); // leaseId -> record
const byKey = new Map(); // keyId  -> Set<leaseId>

const now = () => Date.now();

function indexOf(keyId) {
  let set = byKey.get(keyId);
  if (!set) {
    set = new Set();
    byKey.set(keyId, set);
  }
  return set;
}

function drop(leaseId) {
  const rec = store.get(leaseId);
  if (!rec) return false;
  store.delete(leaseId);
  const set = byKey.get(rec.keyId);
  if (set) {
    set.delete(leaseId);
    if (set.size === 0) byKey.delete(rec.keyId);
  }
  return true;
}

/** Live (unexpired) lease ids for a key, oldest first. */
function liveFor(keyId) {
  const out = [];
  for (const id of indexOf(keyId)) {
    const rec = store.get(id);
    if (rec && rec.expires > now()) out.push(id);
    else drop(id);
  }
  return out;
}

/**
 * Open a lease for a successful auth.
 *
 * When the key is already at its seat limit the OLDEST lease is evicted rather
 * than this one refused: a user whose game crashed should be able to rejoin
 * immediately, not sit out the lease TTL. Genuine sharing shows up instead as a
 * steady stream of evictions, which is a far better signal than a lockout — it
 * is reported back to the caller and recorded.
 *
 * @returns {{lease:string, evicted:number, concurrent:number}}
 */
function open({ keyId, scriptId, hwid = null, ip = null }) {
  sweep();

  const live = liveFor(keyId);
  let evicted = 0;
  const max = Math.max(1, config.leaseMaxPerKey);
  while (live.length >= max) {
    drop(live.shift());
    evicted++;
  }

  const lease = crypto.randomBytes(18).toString('base64url');
  store.set(lease, {
    keyId,
    scriptId: String(scriptId),
    hwid,
    ip,
    beat: 0, // highest counter accepted so far
    opened: now(),
    lastSeen: now(),
    expires: now() + config.leaseTtlMs,
  });
  indexOf(keyId).add(lease);

  return { lease, evicted, concurrent: live.length + 1 };
}

/** The record behind a lease id, or null if unknown/expired. */
function get(lease) {
  const rec = store.get(String(lease || ''));
  if (!rec) return null;
  if (rec.expires <= now()) {
    drop(String(lease));
    return null;
  }
  return rec;
}

/**
 * Accept a beat. `n` must be strictly greater than the highest already seen, so
 * a captured beat cannot be replayed to hold a revoked session open.
 * @returns {{ok:true, rec:object} | {ok:false, reason:string}}
 */
function beat(lease, n) {
  const rec = get(lease);
  if (!rec) return { ok: false, reason: 'unknown_lease' };
  if (!Number.isInteger(n) || n <= rec.beat) return { ok: false, reason: 'stale_beat' };

  rec.beat = n;
  rec.lastSeen = now();
  rec.expires = now() + config.leaseTtlMs;
  return { ok: true, rec };
}

/** Revoke every live lease for a key. Used when a key is banned or paused. */
function revokeKey(keyId) {
  let n = 0;
  for (const id of [...indexOf(keyId)]) {
    if (drop(id)) n++;
  }
  return n;
}

function close(lease) {
  return drop(String(lease || ''));
}

function sweep() {
  const t = now();
  for (const [id, rec] of store) {
    if (rec.expires <= t) drop(id);
  }
}

/** Snapshot for the dashboard: how many sessions are live right now. */
function stats() {
  sweep();
  return { live: store.size, keys: byKey.size };
}

/** Live session count for one key — what the dashboard shows per row. */
function countFor(keyId) {
  return liveFor(keyId).length;
}

/** Test helper — drop every lease. */
function reset() {
  store.clear();
  byKey.clear();
}

const timer = setInterval(sweep, Math.min(60000, Math.max(5000, config.leaseTtlMs)));
if (timer.unref) timer.unref();

module.exports = { open, get, beat, close, revokeKey, countFor, stats, reset, _store: store };
