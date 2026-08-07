'use strict';

const db = require('../db');
const config = require('../config');
const lease = require('./lease');
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
  { count = 1, expiresInDays = null, note = '', discordId = null, resellerId = null } = {}
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

function updateKey(id, fields = {}) {
  const allowed = ['status', 'note', 'discord_id', 'expires_at', 'hwid'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in fields) {
      sets.push(`${k} = ?`);
      vals.push(fields[k]);
    }
  }
  if (!sets.length) return getKeyById(id);
  vals.push(id);
  db.prepare(`UPDATE keys SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

  // Taking a key out of service ends its live sessions too. Without this a ban
  // only stopped the NEXT auth, and the copy already running carried on until
  // the user happened to close the game.
  if (fields.status && fields.status !== 'active') lease.revokeKey(id);
  return getKeyById(id);
}

/** Clear the bound HWID so the key can be used on a new device (admin, unconditional). */
function resetHwid(id) {
  db.prepare(
    'UPDATE keys SET hwid = NULL, hwid_reset_count = hwid_reset_count + 1, last_hwid_reset = ? WHERE id = ?'
  ).run(now(), id);
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
function userResetHwid(key, script) {
  const nowS = now();
  if (!key.hwid) return { ok: false, reason: 'no_hwid' };
  if (script.hwid_reset_limit >= 0 && key.hwid_reset_count >= script.hwid_reset_limit) {
    return { ok: false, reason: 'limit', limit: script.hwid_reset_limit };
  }
  if (key.last_hwid_reset && key.last_hwid_reset + script.hwid_reset_cooldown > nowS) {
    return { ok: false, reason: 'cooldown', wait: key.last_hwid_reset + script.hwid_reset_cooldown - nowS };
  }
  resetHwid(key.id);
  return { ok: true };
}

function deleteKey(id) {
  lease.revokeKey(id);
  return db.prepare('DELETE FROM keys WHERE id = ?').run(id).changes > 0;
}

module.exports = {
  createKeys,
  getKeyByValue,
  getKeyById,
  getKeyByHash,
  getKeyByDiscord,
  listKeys,
  listKeysByReseller,
  updateKey,
  resetHwid,
  userResetHwid,
  deleteKey,
};
