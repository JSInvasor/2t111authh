'use strict';

const db = require('../db');
const { hashPassword, verifyPassword } = require('../utils/password');

const now = () => Math.floor(Date.now() / 1000);

function countAdmins() {
  return db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
}

function getAdmin(username) {
  return db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
}

/**
 * Create the admin, or update the password if it already exists.
 *
 * Changing a password bumps token_version, which invalidates every session
 * token already issued to that admin. Without it a stolen cookie stayed good
 * for its full seven days and changing the password did nothing to stop it.
 */
async function upsertAdmin(username, password) {
  const hash = await hashPassword(password);
  if (getAdmin(username)) {
    db.prepare('UPDATE admins SET password_hash = ?, token_version = token_version + 1 WHERE username = ?').run(
      hash,
      username
    );
  } else {
    db.prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)').run(
      username,
      hash,
      now()
    );
  }
  return getAdmin(username);
}

async function verifyLogin(username, password) {
  const admin = getAdmin(username);
  if (!admin) {
    // Burn similar time on unknown users to avoid a timing oracle.
    await verifyPassword(password, 'scrypt$00$00');
    return null;
  }
  return (await verifyPassword(password, admin.password_hash)) ? admin : null;
}

module.exports = { countAdmins, getAdmin, upsertAdmin, verifyLogin };
