'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

// Password hashing with Node's built-in scrypt (no native/3rd-party deps).
// Stored format:  scrypt$<saltHex>$<hashHex>
//
// Async on purpose. scrypt is memory-hard by design — measured at ~50ms per
// call here — and scryptSync spends every one of those milliseconds blocking
// the event loop, so a trickle of login attempts from enough sources could stall
// the whole server while the rate limiter happily let each one through.

const scrypt = promisify(crypto.scrypt);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, 'hex');
  let derived;
  try {
    derived = await scrypt(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  } catch {
    return false;
  }
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

module.exports = { hashPassword, verifyPassword };
