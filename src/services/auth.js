'use strict';

const db = require('../db');
const config = require('../config');
const { getScript } = require('./scripts');
const { obfuscate } = require('./obfuscator');

const now = () => Math.floor(Date.now() / 1000);

function logExecution({ keyId = null, scriptId, hwid, ip, executor, success, reason }) {
  db.prepare(
    `INSERT INTO executions (key_id, script_id, hwid, ip, executor, success, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(keyId, scriptId, hwid || null, ip || null, executor || null, success ? 1 : 0, reason || null, now());
}

/**
 * Core auth flow used by the Lua loader.
 * Returns { success:true, script, version, expires_at } on success,
 * or { success:false, code, message } on failure.
 */
function authenticate({ scriptId, key, hwid, ip, executor }) {
  const script = getScript(scriptId);
  if (!script) {
    logExecution({ scriptId, hwid, ip, executor, success: false, reason: 'unknown_script' });
    return { success: false, code: 404, message: 'Script not found' };
  }

  if (!script.enabled) {
    logExecution({ scriptId, hwid, ip, executor, success: false, reason: 'script_disabled' });
    return { success: false, code: 503, message: 'This script is temporarily disabled' };
  }

  const execLower = executor ? String(executor).toLowerCase() : '';
  if (execLower && config.blockedExecutors.includes(execLower)) {
    logExecution({ scriptId, hwid, ip, executor, success: false, reason: 'blocked_executor' });
    return { success: false, code: 403, message: 'This executor is not allowed' };
  }
  if (config.allowedExecutors.length && !config.allowedExecutors.includes(execLower)) {
    logExecution({ scriptId, hwid, ip, executor, success: false, reason: 'executor_not_allowed' });
    return { success: false, code: 403, message: 'This executor is not allowed' };
  }

  const row = db.prepare('SELECT * FROM keys WHERE value = ? AND script_id = ?').get(key, scriptId);
  if (!row) {
    logExecution({ scriptId, hwid, ip, executor, success: false, reason: 'invalid_key' });
    return { success: false, code: 401, message: 'Invalid key' };
  }

  if (row.status === 'banned') {
    logExecution({ keyId: row.id, scriptId, hwid, ip, executor, success: false, reason: 'banned' });
    return { success: false, code: 403, message: 'This key is banned' };
  }
  if (row.status === 'paused') {
    logExecution({ keyId: row.id, scriptId, hwid, ip, executor, success: false, reason: 'paused' });
    return { success: false, code: 403, message: 'This key is paused' };
  }
  if (row.expires_at && row.expires_at < now()) {
    logExecution({ keyId: row.id, scriptId, hwid, ip, executor, success: false, reason: 'expired' });
    return { success: false, code: 403, message: 'This key has expired' };
  }

  // HWID lock handling
  if (script.hwid_lock) {
    if (!hwid) {
      logExecution({ keyId: row.id, scriptId, hwid, ip, executor, success: false, reason: 'no_hwid' });
      return { success: false, code: 400, message: 'HWID is required' };
    }
    if (!row.hwid) {
      // First use — bind the key to this device.
      db.prepare('UPDATE keys SET hwid = ? WHERE id = ?').run(hwid, row.id);
    } else if (row.hwid !== hwid) {
      logExecution({ keyId: row.id, scriptId, hwid, ip, executor, success: false, reason: 'hwid_mismatch' });
      return { success: false, code: 403, message: 'HWID mismatch — this key is locked to another device' };
    }
  }

  // Key-sharing detection: if honoring this request would push the key past the
  // allowed number of distinct HWIDs in the window, auto-ban and reject it now —
  // before it counts as a success, so stats aren't polluted and the shared key
  // never receives the source.
  if (isKeyShared(row.id, hwid)) {
    db.prepare("UPDATE keys SET status = 'banned' WHERE id = ?").run(row.id);
    logExecution({ keyId: row.id, scriptId, hwid, ip, executor, success: false, reason: 'auto_banned_sharing' });
    return { success: false, code: 403, message: 'Key banned — sharing detected' };
  }

  // Success — record the execution and hand back the protected source.
  db.prepare('UPDATE keys SET total_executions = total_executions + 1, last_seen = ? WHERE id = ?').run(
    now(),
    row.id
  );
  logExecution({ keyId: row.id, scriptId, hwid, ip, executor, success: true, reason: 'ok' });

  return {
    success: true,
    script: script.obfuscate ? obfuscate(script) : script.source,
    version: script.version,
    expires_at: row.expires_at,
  };
}

/**
 * True if honoring a request from `currentHwid` would exceed the allowed number
 * of distinct HWIDs for this key within the window. The current HWID is counted
 * even though this request hasn't been logged yet, so the limit is enforced on
 * the offending request itself rather than one execution late.
 */
function isKeyShared(keyId, currentHwid) {
  if (!config.keyShareMaxHwids || config.keyShareMaxHwids < 1) return false;
  const since = now() - Math.floor(config.keyShareWindowMs / 1000);
  const rows = db
    .prepare(
      `SELECT DISTINCT hwid FROM executions
       WHERE key_id = ? AND success = 1 AND hwid IS NOT NULL AND created_at >= ?`
    )
    .all(keyId, since);
  const seen = new Set(rows.map((r) => r.hwid));
  if (currentHwid) seen.add(String(currentHwid));
  return seen.size > config.keyShareMaxHwids;
}

module.exports = { authenticate };
