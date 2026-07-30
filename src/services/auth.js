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

  // Success — record the execution and hand back the protected source.
  db.prepare('UPDATE keys SET total_executions = total_executions + 1, last_seen = ? WHERE id = ?').run(
    now(),
    row.id
  );
  logExecution({ keyId: row.id, scriptId, hwid, ip, executor, success: true, reason: 'ok' });

  // Key-sharing detection: too many distinct HWIDs in the window -> auto-ban.
  if (isKeyShared(row.id)) {
    db.prepare("UPDATE keys SET status = 'banned' WHERE id = ?").run(row.id);
    logExecution({ keyId: row.id, scriptId, hwid, ip, executor, success: false, reason: 'auto_banned_sharing' });
    return { success: false, code: 403, message: 'Key banned — sharing detected' };
  }

  return {
    success: true,
    script: script.obfuscate ? obfuscate(script) : script.source,
    version: script.version,
    expires_at: row.expires_at,
  };
}

/** True if a key has been used from more distinct HWIDs than allowed in the window. */
function isKeyShared(keyId) {
  if (!config.keyShareMaxHwids || config.keyShareMaxHwids < 1) return false;
  const since = now() - Math.floor(config.keyShareWindowMs / 1000);
  const { c } = db
    .prepare(
      `SELECT COUNT(DISTINCT hwid) AS c FROM executions
       WHERE key_id = ? AND success = 1 AND hwid IS NOT NULL AND created_at >= ?`
    )
    .get(keyId, since);
  return c > config.keyShareMaxHwids;
}

module.exports = { authenticate };
