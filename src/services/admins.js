'use strict';

// Admin accounts.
//
// Exactly one admin is the owner, and only the owner may manage the others.
// Without that distinction every admin could mint more admins, which flattens
// the hierarchy into "everyone is root": one compromised or disgruntled account
// could quietly create its own way back in, and there would be no account able
// to shut it out again. The owner is the account the operator set up first.
//
// The master ADMIN_API_KEY is treated as the owner wherever it is used. It is
// the root credential and the recovery path — if it could not manage admins, a
// lost owner password would mean editing the database by hand.

const db = require('../db');
const audit = require('./audit');
const { hashPassword, verifyPassword } = require('../utils/password');

const now = () => Math.floor(Date.now() / 1000);

// Never select password_hash into anything that can reach a response.
const PUBLIC_COLS = 'id, username, is_owner, token_version, created_at';

function countAdmins() {
  return db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
}

function getAdmin(username) {
  return db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
}

function getById(id) {
  return db.prepare(`SELECT ${PUBLIC_COLS} FROM admins WHERE id = ?`).get(id);
}

function list() {
  return db.prepare(`SELECT ${PUBLIC_COLS} FROM admins ORDER BY is_owner DESC, username`).all();
}

/** The owner row, or undefined on a database with no admins at all. */
function owner() {
  return db.prepare(`SELECT ${PUBLIC_COLS} FROM admins WHERE is_owner = 1`).get();
}

function isOwner(username) {
  const row = getAdmin(username);
  return !!(row && row.is_owner);
}

/**
 * Create the admin, or update the password if it already exists.
 *
 * Changing a password bumps token_version, which invalidates every session
 * token already issued to that admin. Without it a stolen cookie stayed good
 * for its full seven days and changing the password did nothing to stop it.
 *
 * The first admin on a fresh install becomes the owner — otherwise `npm run
 * create-admin` would produce an install nobody can administer.
 */
async function upsertAdmin(username, password, { actor = null } = {}) {
  const hash = await hashPassword(password);
  const existing = getAdmin(username);

  if (existing) {
    db.prepare('UPDATE admins SET password_hash = ?, token_version = token_version + 1 WHERE username = ?').run(
      hash,
      username
    );
    audit.record({ actor, action: 'admin.set_password', targetType: 'admin', targetId: existing.id });
  } else {
    const firstEver = countAdmins() === 0;
    const info = db
      .prepare('INSERT INTO admins (username, password_hash, created_at, is_owner) VALUES (?, ?, ?, ?)')
      .run(username, hash, now(), firstEver ? 1 : 0);
    audit.record({
      actor,
      action: 'admin.create',
      targetType: 'admin',
      targetId: info.lastInsertRowid,
      detail: { username, is_owner: firstEver },
    });
  }
  return getAdmin(username);
}

/** Set one admin's password by id. */
async function setPassword(id, password, { actor = null } = {}) {
  const hash = await hashPassword(password);
  db.prepare('UPDATE admins SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(hash, id);
  audit.record({ actor, action: 'admin.set_password', targetType: 'admin', targetId: id });
  return getById(id);
}

/**
 * Delete an admin.
 *
 * The owner is never deletable and neither is the last remaining admin: both
 * would leave an install nobody can administer, and the only way back would be
 * editing the database by hand. The caller is expected to have checked
 * permissions; these are the invariants that hold regardless of who asked.
 *
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
function remove(id, { actor = null } = {}) {
  const row = db.prepare('SELECT id, username, is_owner FROM admins WHERE id = ?').get(id);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.is_owner) return { ok: false, reason: 'owner' };
  if (countAdmins() <= 1) return { ok: false, reason: 'last_admin' };

  db.prepare('DELETE FROM admins WHERE id = ?').run(id);
  // Their cookie dies with the row: requireAdmin re-reads the account on every
  // request, so a deleted admin's session stops working immediately.
  audit.record({
    actor,
    action: 'admin.delete',
    targetType: 'admin',
    targetId: id,
    detail: { username: row.username },
  });
  return { ok: true };
}

/**
 * Hand ownership to another admin. There is exactly one owner before and after,
 * enforced in a single transaction.
 *
 * This exists so that an owner leaving is not a dead end. Without it the only
 * ways out are the master API key or editing the database directly.
 *
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
function transferOwnership(toId, { actor = null } = {}) {
  const target = db.prepare('SELECT id, username, is_owner FROM admins WHERE id = ?').get(toId);
  if (!target) return { ok: false, reason: 'not_found' };
  if (target.is_owner) return { ok: false, reason: 'already_owner' };

  const previous = owner();
  db.transaction(() => {
    db.prepare('UPDATE admins SET is_owner = 0 WHERE is_owner = 1').run();
    db.prepare('UPDATE admins SET is_owner = 1 WHERE id = ?').run(toId);
  })();

  audit.record({
    actor,
    action: 'admin.transfer_ownership',
    targetType: 'admin',
    targetId: toId,
    detail: { to: target.username, from: previous ? previous.username : null },
  });
  return { ok: true };
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

/** Check a password against one account — used to confirm a self-service change. */
async function checkPassword(id, password) {
  const row = db.prepare('SELECT password_hash FROM admins WHERE id = ?').get(id);
  if (!row) return false;
  return verifyPassword(password, row.password_hash);
}

module.exports = {
  countAdmins,
  getAdmin,
  getById,
  list,
  owner,
  isOwner,
  upsertAdmin,
  setPassword,
  checkPassword,
  remove,
  transferOwnership,
  verifyLogin,
};
