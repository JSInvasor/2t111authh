'use strict';

const crypto = require('crypto');

// Unambiguous alphabet (no 0/O/1/I) so keys are easy to read/type.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Cryptographically-random string over the given alphabet. */
function randomString(len, alphabet = ALPHABET) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** Generate a license key like  2t1_ABCD1234-EFGH5678-... */
function generateKey(prefix) {
  const seg = () => randomString(8);
  const body = `${seg()}-${seg()}-${seg()}-${seg()}`;
  return prefix ? `${prefix}_${body}` : body;
}

/** Short opaque id used in loader URLs (16 hex chars). */
function generateScriptId() {
  return crypto.randomBytes(8).toString('hex');
}

/** Constant-time string comparison (for admin key / secrets). */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = { randomString, generateKey, generateScriptId, safeEqual };
