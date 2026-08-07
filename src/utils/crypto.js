'use strict';

const crypto = require('crypto');

// Unambiguous alphabet (no 0/O/1/I) so keys are easy to read/type.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Per-process secret behind decoyServerProof(). Deliberately not persisted:
// it only has to be unguessable for the lifetime of a handshake.
const DECOY_SECRET = crypto.randomBytes(32);

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
 * These helpers are mirrored byte-for-byte by the Lua loader
 * (lua/loader_template.lua + lua/sha256.lua). Change one side and you must
 * change the other, or every auth will fail its proof check.
 *
 * Fields are joined with "|", which is safe because every component is
 * normalised to a charset that excludes it (see services/auth.js).
 *
 * The protocol is mutually authenticated and anchored on the license key —
 * the one secret a genuine client and this server already share. The key
 * itself never travels: the client identifies itself by keyHash(), and each
 * side proves it holds the real key by HMAC'ing under it.
 *
 *   client → handshake { script_id, kh }
 *   server → { nonce, salt, server_proof }      ← proves the server knows the key
 *   client verifies server_proof, and only then continues
 *   client → auth { script_id, kh, nonce, hwid, executor, proof }
 *   server → { script, enc, resp_proof }        ← binds the payload to key+nonce
 *
 * Without this the server was never authenticated at all: anything that could
 * answer HTTP could hand the loader plaintext Lua and have it executed, with
 * no key, nonce or proof of any kind (see test/attacker.test.js).
 */

function joinFields(parts) {
  return parts.map((p) => (p == null ? '' : String(p))).join('|');
}

/**
 * Public, irreversible identifier for a key. This is what goes on the wire in
 * place of the key, so a hostile or compromised endpoint learns nothing reusable
 * — a key carries ~160 bits of entropy, so the hash cannot be walked back.
 */
function keyHash(key) {
  return crypto.createHash('sha256').update('2t1kh|' + String(key)).digest('hex');
}

/**
 * The server's answer to the handshake, HMAC'd under the key the client claims
 * to hold. Only something with the real key in hand can produce it, so the
 * loader can tell our server apart from anything else that answers the URL.
 */
function serverProof({ key, nonce, salt, scriptId }) {
  return crypto
    .createHmac('sha256', String(key))
    .update('2t1srv|' + joinFields([nonce, salt, scriptId]))
    .digest('hex');
}

/**
 * Stand-in returned when the handshake names a key we don't have. Deterministic
 * per kh and unforgeable, so an unknown key is indistinguishable from a wrong
 * proof and the handshake can't be used to test whether a key exists.
 */
function decoyServerProof(kh) {
  return crypto.createHmac('sha256', DECOY_SECRET).update('2t1decoy|' + String(kh)).digest('hex');
}

/**
 * Proof the loader sends with /api/v1/auth, keyed by the license key, over the
 * exact request it is about to make. Editing any field of a captured request
 * invalidates it, and the key never appears in the request itself.
 */
function clientProof({ key, nonce, scriptId, hwid, executor, device = '', env = '' }) {
  return crypto
    .createHmac('sha256', String(key))
    .update('2t1cli|' + joinFields([nonce, scriptId, hwid, executor, device, env]))
    .digest('hex');
}

/**
 * Proof attached to a tamper report. Reports carry a ban lever (TAMPER_REPORT_BAN),
 * so they must be provably from someone holding the key — otherwise anyone who
 * merely learned a key's value could file reports until that key was banned.
 */
function reportProof({ key, nonce, scriptId, reason }) {
  return crypto
    .createHmac('sha256', String(key))
    .update('2t1rep|' + joinFields([nonce, scriptId, reason]))
    .digest('hex');
}

/**
 * A single heartbeat against a live lease. Keyed by the license key so it can't
 * be forged by anything that merely watched one go past, and numbered so a
 * captured beat can't be replayed to hold a revoked session open.
 */
function beatProof({ key, lease, n }) {
  return crypto
    .createHmac('sha256', String(key))
    .update('2t1hb|' + joinFields([lease, n]))
    .digest('hex');
}

/**
 * Signature over the auth response. Covers `enc` and the lease as well as the
 * payload, so a response cannot be downgraded from session-encrypted to
 * plaintext, cannot be stripped of its lease to dodge revocation, and cannot be
 * swapped or edited in flight. `script` stays last because it is the only field
 * whose contents are unconstrained.
 */
function responseProof({ key, nonce, enc, lease, script }) {
  return crypto
    .createHmac('sha256', String(key))
    .update('2t1res|' + joinFields([nonce, enc || '', lease || '', script]))
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
  keyHash,
  serverProof,
  decoyServerProof,
  clientProof,
  reportProof,
  beatProof,
  responseProof,
  sessionKey,
};
