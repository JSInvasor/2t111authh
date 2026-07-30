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

/** Create the admin, or update the password if it already exists. */
function upsertAdmin(username, password) {
  const hash = hashPassword(password);
  if (getAdmin(username)) {
    db.prepare('UPDATE admins SET password_hash = ? WHERE username = ?').run(hash, username);
  } else {
    db.prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)').run(
      username,
      hash,
      now()
    );
  }
  return getAdmin(username);
}

function verifyLogin(username, password) {
  const admin = getAdmin(username);
  if (!admin) {
    // Burn similar time on unknown users to avoid a timing oracle.
    verifyPassword(password, 'scrypt$00$00');
    return false;
  }
  return verifyPassword(password, admin.password_hash);
}

module.exports = { countAdmins, getAdmin, upsertAdmin, verifyLogin };
