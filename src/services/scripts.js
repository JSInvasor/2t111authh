'use strict';

const db = require('../db');
const { generateScriptId } = require('../utils/crypto');

const now = () => Math.floor(Date.now() / 1000);

function createScript({
  name,
  source = '',
  version = '1.0.0',
  hwid_lock = 1,
  hwid_reset_cooldown = 86400,
  hwid_reset_limit = 3,
  obfuscate = 1,
  enabled = 1,
} = {}) {
  const id = generateScriptId();
  const t = now();
  db.prepare(
    `INSERT INTO scripts (id, name, source, version, hwid_lock, hwid_reset_cooldown, hwid_reset_limit, obfuscate, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, source, version, hwid_lock ? 1 : 0, hwid_reset_cooldown, hwid_reset_limit, obfuscate ? 1 : 0, enabled ? 1 : 0, t, t);
  return getScript(id);
}

function getScript(id) {
  return db.prepare('SELECT * FROM scripts WHERE id = ?').get(id);
}

function listScripts() {
  return db
    .prepare(
      `SELECT s.id, s.name, s.version, s.hwid_lock, s.hwid_reset_cooldown, s.hwid_reset_limit,
              s.obfuscate, s.enabled, s.created_at, s.updated_at,
              (SELECT COUNT(*) FROM keys k WHERE k.script_id = s.id) AS key_count,
              (SELECT COUNT(*) FROM keys k WHERE k.script_id = s.id AND k.status = 'active') AS active_keys
       FROM scripts s
       ORDER BY s.created_at DESC`
    )
    .all();
}

function updateScript(id, fields = {}) {
  const allowed = ['name', 'source', 'version', 'hwid_lock', 'hwid_reset_cooldown', 'hwid_reset_limit', 'obfuscate', 'enabled'];
  const boolCols = new Set(['hwid_lock', 'obfuscate', 'enabled']);
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in fields) {
      sets.push(`${k} = ?`);
      vals.push(boolCols.has(k) ? (fields[k] ? 1 : 0) : fields[k]);
    }
  }
  if (!sets.length) return getScript(id);
  sets.push('updated_at = ?');
  vals.push(now(), id);
  db.prepare(`UPDATE scripts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getScript(id);
}

function deleteScript(id) {
  return db.prepare('DELETE FROM scripts WHERE id = ?').run(id).changes > 0;
}

module.exports = { createScript, getScript, listScripts, updateScript, deleteScript };
