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

/* ----------------------- loader session binding -----------------------
 * These three helpers are mirrored byte-for-byte by the Lua loader
 * (lua/loader_template.lua + lua/sha256.lua). Change one side and you must
 * change the other, or every auth will fail its proof check.
 *
 * Fields are joined with "|", which is safe because every component is
 * normalised to a charset that excludes it (see services/auth.js).
 */

function joinFields(parts) {
  return parts.map((p) => (p == null ? '' : String(p))).join('|');
}

/**
 * Proof the loader sends with /api/v1/auth: HMAC-SHA256, keyed by the salt the
 * handshake just handed out, over the request it is about to make. Ties the
 * handshake to this exact auth call — a captured request can't be edited
 * (different hwid/key/executor ⇒ different proof) and the salt never appears
 * in the auth request itself.
 */
function sessionProof({ salt, nonce, scriptId, key, hwid, executor }) {
  return crypto
    .createHmac('sha256', String(salt))
    .update(joinFields([nonce, scriptId, key, hwid, executor]))
    .digest('hex');
}

/**
 * Key the delivered payload is encrypted under. Derived from values only the
 * live session knows, so a payload lifted out of a proxy log or shared around
 * is undecryptable without replaying the whole handshake as that same client.
 * @returns {Buffer} 32 raw bytes
 */
function sessionKey({ salt, nonce, scriptId, key, hwid }) {
  return crypto
    .createHash('sha256')
    .update(joinFields([salt, nonce, scriptId, key, hwid]))
    .digest();
}

module.exports = {
  randomString,
  generateKey,
  generateScriptId,
  safeEqual,
  sessionProof,
  sessionKey,
};
