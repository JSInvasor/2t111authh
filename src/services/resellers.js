'use strict';

const db = require('../db');
const audit = require('./audit');
const { hashPassword, verifyPassword } = require('../utils/password');

const now = () => Math.floor(Date.now() / 1000);

const publicCols =
  'id, username, credits, enabled, created_at, ' +
  '(SELECT COUNT(*) FROM reseller_scripts rs WHERE rs.reseller_id = resellers.id) AS scripts, ' +
  '(SELECT COUNT(*) FROM keys k WHERE k.reseller_id = resellers.id) AS keys';

async function create({ username, password, credits = 0, actor = null }) {
  const hash = await hashPassword(password);
  const info = db
    .prepare('INSERT INTO resellers (username, password_hash, credits, created_at) VALUES (?, ?, ?, ?)')
    .run(username, hash, Math.max(0, parseInt(credits, 10) || 0), now());

  audit.record({
    actor,
    action: 'reseller.create',
    targetType: 'reseller',
    targetId: info.lastInsertRowid,
    detail: { username, credits: Math.max(0, parseInt(credits, 10) || 0) },
  });
  return getById(info.lastInsertRowid);
}

function getById(id) {
  return db.prepare(`SELECT ${publicCols} FROM resellers WHERE id = ?`).get(id);
}
function getByUsername(username) {
  return db.prepare('SELECT * FROM resellers WHERE username = ?').get(username);
}
function list() {
  return db.prepare(`SELECT ${publicCols} FROM resellers ORDER BY created_at DESC`).all();
}

/** Changing the password also retires every session token issued before it. */
async function setPassword(id, password, { actor = null } = {}) {
  const hash = await hashPassword(password);
  db.prepare('UPDATE resellers SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(hash, id);
  audit.record({ actor, action: 'reseller.set_password', targetType: 'reseller', targetId: id });
}
function setEnabled(id, enabled, { actor = null } = {}) {
  db.prepare('UPDATE resellers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  audit.record({
    actor,
    action: enabled ? 'reseller.enable' : 'reseller.disable',
    targetType: 'reseller',
    targetId: id,
  });
  return getById(id);
}

/** Add (or, with a negative amount, remove) credits. Never drops below 0. */
function addCredits(id, amount, { actor = null } = {}) {
  const n = parseInt(amount, 10) || 0;
  const before = getById(id);
  db.prepare('UPDATE resellers SET credits = MAX(0, credits + ?) WHERE id = ?').run(n, id);
  const after = getById(id);
  audit.record({
    actor,
    action: 'reseller.credits',
    targetType: 'reseller',
    targetId: id,
    detail: { amount: n, from: before ? before.credits : null, to: after ? after.credits : null },
  });
  return after;
}

/** Atomically spend credits. Returns true only if the balance was sufficient. */
function spendCredits(id, amount) {
  const n = Math.max(0, parseInt(amount, 10) || 0);
  const info = db.prepare('UPDATE resellers SET credits = credits - ? WHERE id = ? AND credits >= ?').run(n, id, n);
  return info.changes > 0;
}

function remove(id, { actor = null } = {}) {
  const before = getById(id);
  // Detach the reseller's keys (keep the keys, just unlink), then delete.
  db.prepare('UPDATE keys SET reseller_id = NULL WHERE reseller_id = ?').run(id);
  const gone = db.prepare('DELETE FROM resellers WHERE id = ?').run(id).changes > 0;
  if (gone) {
    audit.record({
      actor,
      action: 'reseller.delete',
      targetType: 'reseller',
      targetId: id,
      detail: { username: before ? before.username : null, keys_detached: before ? before.keys : null },
    });
  }
  return gone;
}

// ---- script assignment ----

function assignScript(resellerId, scriptId, { actor = null } = {}) {
  db.prepare('INSERT OR IGNORE INTO reseller_scripts (reseller_id, script_id) VALUES (?, ?)').run(resellerId, scriptId);
  audit.record({
    actor,
    action: 'reseller.assign_script',
    targetType: 'reseller',
    targetId: resellerId,
    detail: { script_id: scriptId },
  });
}
function unassignScript(resellerId, scriptId, { actor = null } = {}) {
  db.prepare('DELETE FROM reseller_scripts WHERE reseller_id = ? AND script_id = ?').run(resellerId, scriptId);
  audit.record({
    actor,
    action: 'reseller.unassign_script',
    targetType: 'reseller',
    targetId: resellerId,
    detail: { script_id: scriptId },
  });
}
function hasScript(resellerId, scriptId) {
  return !!db
    .prepare('SELECT 1 FROM reseller_scripts WHERE reseller_id = ? AND script_id = ?')
    .get(resellerId, scriptId);
}
/** Assigned scripts WITHOUT source (resellers must not see the code). */
function scriptsFor(resellerId) {
  return db
    .prepare(
      `SELECT s.id, s.name, s.version, s.enabled
       FROM reseller_scripts rs JOIN scripts s ON s.id = rs.script_id
       WHERE rs.reseller_id = ?
       ORDER BY s.name`
    )
    .all(resellerId);
}

async function verifyLogin(username, password) {
  const r = getByUsername(username);
  if (!r) {
    await verifyPassword(password, 'scrypt$00$00'); // constant-ish time
    return null;
  }
  if (!(await verifyPassword(password, r.password_hash))) return null;
  return r;
}

module.exports = {
  create,
  getById,
  getByUsername,
  list,
  setPassword,
  setEnabled,
  addCredits,
  spendCredits,
  remove,
  assignScript,
  unassignScript,
  hasScript,
  scriptsFor,
  verifyLogin,
};
