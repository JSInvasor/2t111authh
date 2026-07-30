'use strict';

// Single-use, short-lived nonces for the loader handshake (replay protection).
// In-memory store — only the API process issues/consumes them.

const crypto = require('crypto');
const config = require('../config');

const store = new Map(); // nonce -> { scriptId, expires }

/** Issue a fresh nonce bound to a script. */
function issue(scriptId) {
  const nonce = crypto.randomBytes(18).toString('base64url');
  store.set(nonce, { scriptId: String(scriptId), expires: Date.now() + config.nonceTtlMs });
  return nonce;
}

/** Consume a nonce. Returns true only if it exists, is unexpired, and matches the script. */
function consume(nonce, scriptId) {
  const rec = store.get(nonce);
  if (!rec) return false;
  store.delete(nonce); // single use
  if (rec.expires < Date.now()) return false;
  if (rec.scriptId !== String(scriptId)) return false;
  return true;
}

function sweep() {
  const now = Date.now();
  for (const [k, v] of store) if (v.expires < now) store.delete(k);
}

// Periodic cleanup; unref so it never keeps the process (or test runner) alive.
const timer = setInterval(sweep, Math.max(5000, config.nonceTtlMs));
if (timer.unref) timer.unref();

module.exports = { issue, consume, sweep, _store: store };
