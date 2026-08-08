'use strict';

const db = require('../db');
const config = require('../config');
const lease = require('./lease');
const audit = require('./audit');
const { generateKey, keyHash } = require('../utils/crypto');

const now = () => Math.floor(Date.now() / 1000);

/**
 * Create one or more keys for a script.
 * @param {string} scriptId
 * @param {{count?:number, expiresInDays?:number|null, note?:string, discordId?:string|null, resellerId?:number|null}} opts
 * @returns {object[]} the created key rows
 */
function createKeys(
  scriptId,
  { count = 1, expiresInDays = null, note = '', discordId = null, resellerId = null, actor = null } = {}
) {
  const insert = db.prepare(
    `INSERT INTO keys (value, kh, script_id, note, discord_id, expires_at, reseller_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const t = now();
  const expiresAt = expiresInDays ? t + Math.round(Number(expiresInDays) * 86400) : null;
  const n = Math.max(1, Math.min(parseInt(count, 10) || 1, 1000));
  const created = [];

  const tx = db.transaction(() => {
    for (let i = 0; i < n; i++) {
      // Retry on the (astronomically unlikely) unique collision.
      for (let attempt = 0; ; attempt++) {
        const value = generateKey(config.keyPrefix);
        try {
          insert.run(value, keyHash(value), scriptId, note, discordId, expiresAt, resellerId, t);
          created.push(value);
          break;
        } catch (e) {
          if (attempt >= 4) throw e;
        }
      }
    }
  });
  tx();

  audit.record({
    actor,
    action: 'key.create',
    targetType: 'script',
    targetId: scriptId,
    detail: { count: created.length, expires_in_days: expiresInDays, reseller_id: resellerId, note },
  });
  return created.map(getKeyByValue);
}

function getKeyByValue(value) {
  return db.prepare('SELECT * FROM keys WHERE value = ?').get(value);
}

function getKeyById(id) {
  return db.prepare('SELECT * FROM keys WHERE id = ?').get(id);
}

/**
 * Resolve the key a loader named by hash. This is the only lookup the public
 * auth path performs, because the loader never sends the key itself.
 */
function getKeyByHash(kh, scriptId) {
  return db.prepare('SELECT * FROM keys WHERE kh = ? AND script_id = ?').get(String(kh), String(scriptId));
}

function listKeys(scriptId, { limit = 100, offset = 0 } = {}) {
  return db
    .prepare('SELECT * FROM keys WHERE script_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(scriptId, limit, offset);
}

/**
 * Every key that could have produced a leaked copy of this script, lean enough
 * to score tens of thousands of them at once. Revoked and expired keys are
 * included on purpose: a leak is usually older than the ban that followed it.
 */
function allKeysForTrace(scriptId) {
  return db
    .prepare(
      `SELECT id, value, status, note, discord_id, hwid, last_seen, created_at
         FROM keys WHERE script_id = ? ORDER BY id`
    )
    .all(scriptId);
}

/** Keys created by a specific reseller (optionally filtered to one script). */
function listKeysByReseller(resellerId, { scriptId = null, limit = 1000, offset = 0 } = {}) {
  if (scriptId) {
    return db
      .prepare(
        'SELECT * FROM keys WHERE reseller_id = ? AND script_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
      )
      .all(resellerId, scriptId, limit, offset);
  }
  return db
    .prepare('SELECT * FROM keys WHERE reseller_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(resellerId, limit, offset);
}

function updateKey(id, fields = {}, { actor = null } = {}) {
  const allowed = ['status', 'note', 'discord_id', 'expires_at', 'hwid'];
  const sets = [];
  const vals = [];
  const changed = {};
  for (const k of allowed) {
    if (k in fields) {
      sets.push(`${k} = ?`);
      vals.push(fields[k]);
      changed[k] = fields[k];
    }
  }
  if (!sets.length) return getKeyById(id);

  const before = getKeyById(id);
  vals.push(id);
  db.prepare(`UPDATE keys SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

  // Taking a key out of service ends its live sessions too. Without this a ban
  // only stopped the NEXT auth, and the copy already running carried on until
  // the user happened to close the game.
  if (fields.status && fields.status !== 'active') lease.revokeKey(id);

  audit.record({
    actor,
    action: fields.status ? `key.${fields.status}` : 'key.update',
    targetType: 'key',
    targetId: id,
    detail: { changed, from: before ? { status: before.status } : null },
  });
  return getKeyById(id);
}

/** Clear the bound HWID so the key can be used on a new device (admin, unconditional). */
function resetHwid(id, { actor = null } = {}) {
  const before = getKeyById(id);
  // The device token goes with it: leaving it behind would keep the key pinned
  // to the old machine through the token even though the HWID was cleared.
  db.prepare(
    `UPDATE keys SET hwid = NULL, device_token = NULL,
            hwid_reset_count = hwid_reset_count + 1, last_hwid_reset = ? WHERE id = ?`
  ).run(now(), id);

  audit.record({
    actor,
    action: 'key.reset_hwid',
    targetType: 'key',
    targetId: id,
    detail: { from_hwid: before ? before.hwid : null },
  });
  return getKeyById(id);
}

/** Find the (most recent) key linked to a Discord user for a given script. */
function getKeyByDiscord(scriptId, discordId) {
  return db
    .prepare('SELECT * FROM keys WHERE script_id = ? AND discord_id = ? ORDER BY created_at DESC')
    .get(scriptId, discordId);
}

/**
 * User-initiated HWID reset, enforcing the script's cooldown + reset limit.
 * Returns { ok:true } or { ok:false, reason:'no_hwid'|'limit'|'cooldown', ... }.
 */
function userResetHwid(key, script, { actor = null } = {}) {
  const nowS = now();
  if (!key.hwid) return { ok: false, reason: 'no_hwid' };
  if (script.hwid_reset_limit >= 0 && key.hwid_reset_count >= script.hwid_reset_limit) {
    return { ok: false, reason: 'limit', limit: script.hwid_reset_limit };
  }
  if (key.last_hwid_reset && key.last_hwid_reset + script.hwid_reset_cooldown > nowS) {
    return { ok: false, reason: 'cooldown', wait: key.last_hwid_reset + script.hwid_reset_cooldown - nowS };
  }
  resetHwid(key.id, { actor });
  return { ok: true };
}

function deleteKey(id, { actor = null } = {}) {
  const before = getKeyById(id);
  lease.revokeKey(id);
  const gone = db.prepare('DELETE FROM keys WHERE id = ?').run(id).changes > 0;
  if (gone) {
    // The key value is recorded because after the row is gone this entry is the
    // only thing that can answer "what happened to the key I bought".
    audit.record({
      actor,
      action: 'key.delete',
      targetType: 'key',
      targetId: id,
      detail: { value: before ? before.value : null, script_id: before ? before.script_id : null },
    });
  }
  return gone;
}

module.exports = {
  createKeys,
  getKeyByValue,
  getKeyById,
  getKeyByHash,
  getKeyByDiscord,
  listKeys,
  listKeysByReseller,
  allKeysForTrace,
  updateKey,
  resetHwid,
  userResetHwid,
  deleteKey,
};
