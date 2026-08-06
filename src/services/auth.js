'use strict';

const db = require('../db');
const config = require('../config');
const { getScript } = require('./scripts');
const { obfuscate } = require('./obfuscator');
const { sessionKey } = require('../utils/crypto');

const now = () => Math.floor(Date.now() / 1000);

// A real HWID is an opaque device id. Restricting the charset keeps junk out of
// the database and guarantees the "|" separator used by the session proof can
// never appear inside a field (which would make the hash ambiguous).
const HWID_RE = /^[A-Za-z0-9._:-]+$/;

// Values executors hand back when HWID collection fails. Binding a key to one of
// these would lock it to "every device that also failed", which is no lock at all.
const PLACEHOLDER_HWIDS = new Set([
  'unknown',
  'nil',
  'null',
  'none',
  'undefined',
  'false',
  '0',
  '00000000-0000-0000-0000-000000000000',
]);

/** Executor names are untrusted display data — keep a tame copy for matching/storage. */
function cleanExecutor(executor) {
  if (executor == null) return null;
  const s = String(executor)
    .replace(/[^A-Za-z0-9._ -]/g, '')
    .trim()
    .slice(0, 64);
  return s || null;
}

/** @returns {{ok:true}|{ok:false, reason:string}} */
function checkHwid(hwid) {
  if (!hwid) return { ok: false, reason: 'no_hwid' };
  if (hwid.length > config.hwidMaxLength) return { ok: false, reason: 'hwid_too_long' };
  if (!HWID_RE.test(hwid)) return { ok: false, reason: 'bad_hwid' };
  if (PLACEHOLDER_HWIDS.has(hwid.toLowerCase())) return { ok: false, reason: 'placeholder_hwid' };
  return { ok: true };
}

function logExecution({ keyId = null, scriptId, hwid, ip, executor, success, reason }) {
  db.prepare(
    `INSERT INTO executions (key_id, script_id, hwid, ip, executor, success, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    keyId,
    scriptId,
    hwid ? String(hwid).slice(0, config.hwidMaxLength) : null,
    ip || null,
    executor || null,
    success ? 1 : 0,
    reason || null,
    now()
  );
}

/**
 * Core auth flow used by the Lua loader.
 * @param {{scriptId:string, key:string, hwid?:string|null, ip?:string|null,
 *          executor?:string|null, session?:{salt:string, nonce:string}|null}} args
 * @returns {{success:true, script:string, enc?:'session', version:string, expires_at:number|null}
 *          | {success:false, code:number, message:string}}
 */
function authenticate({ scriptId, key, hwid, ip, executor, session = null }) {
  const exec = cleanExecutor(executor);
  const ctx = { scriptId, hwid, ip, executor: exec };

  const script = getScript(scriptId);
  if (!script) {
    logExecution({ ...ctx, success: false, reason: 'unknown_script' });
    return { success: false, code: 404, message: 'Script not found' };
  }

  if (!script.enabled) {
    logExecution({ ...ctx, success: false, reason: 'script_disabled' });
    return { success: false, code: 503, message: 'This script is temporarily disabled' };
  }

  const execLower = exec ? exec.toLowerCase() : '';
  if (execLower && config.blockedExecutors.includes(execLower)) {
    logExecution({ ...ctx, success: false, reason: 'blocked_executor' });
    return { success: false, code: 403, message: 'This executor is not allowed' };
  }
  if (config.allowedExecutors.length && !config.allowedExecutors.includes(execLower)) {
    logExecution({ ...ctx, success: false, reason: 'executor_not_allowed' });
    return { success: false, code: 403, message: 'This executor is not allowed' };
  }

  const row = db.prepare('SELECT * FROM keys WHERE value = ? AND script_id = ?').get(key, scriptId);
  if (!row) {
    logExecution({ ...ctx, success: false, reason: 'invalid_key' });
    return { success: false, code: 401, message: 'Invalid key' };
  }

  if (row.status === 'banned') {
    logExecution({ ...ctx, keyId: row.id, success: false, reason: 'banned' });
    return { success: false, code: 403, message: 'This key is banned' };
  }
  if (row.status === 'paused') {
    logExecution({ ...ctx, keyId: row.id, success: false, reason: 'paused' });
    return { success: false, code: 403, message: 'This key is paused' };
  }
  if (row.expires_at && row.expires_at < now()) {
    logExecution({ ...ctx, keyId: row.id, success: false, reason: 'expired' });
    return { success: false, code: 403, message: 'This key has expired' };
  }

  // HWID lock handling
  if (script.hwid_lock) {
    const check = checkHwid(hwid);
    if (!check.ok) {
      logExecution({ ...ctx, keyId: row.id, success: false, reason: check.reason });
      return {
        success: false,
        code: 400,
        message: check.reason === 'no_hwid' ? 'HWID is required' : 'Invalid HWID',
      };
    }

    if (!row.hwid) {
      // First use — bind the key to this device. Conditional UPDATE so two
      // devices racing a fresh key can't both bind: exactly one write wins and
      // the loser falls through to the mismatch branch below.
      const bound = db.prepare('UPDATE keys SET hwid = ? WHERE id = ? AND hwid IS NULL').run(hwid, row.id);
      if (bound.changes === 0) {
        const current = db.prepare('SELECT hwid FROM keys WHERE id = ?').get(row.id);
        if (!current || current.hwid !== hwid) {
          logExecution({ ...ctx, keyId: row.id, success: false, reason: 'hwid_mismatch' });
          return { success: false, code: 403, message: 'HWID mismatch — this key is locked to another device' };
        }
      }
    } else if (row.hwid !== hwid) {
      logExecution({ ...ctx, keyId: row.id, success: false, reason: 'hwid_mismatch' });
      return { success: false, code: 403, message: 'HWID mismatch — this key is locked to another device' };
    }
  }

  // Per-key throttle. A key is one seat; a script that re-auths in a loop (or a
  // cracked loader hammering for payloads) gets slowed down without a ban.
  if (keyThrottled(row.id)) {
    logExecution({ ...ctx, keyId: row.id, success: false, reason: 'key_rate_limited' });
    return { success: false, code: 429, message: 'Too many requests for this key, slow down.' };
  }

  // Key-sharing detection: if honoring this request would push the key past the
  // allowed number of distinct HWIDs (or IPs) in the window, auto-ban and reject
  // it now — before it counts as a success, so stats aren't polluted and the
  // shared key never receives the source.
  const shared = sharingViolation(row.id, { hwid, ip });
  if (shared) {
    db.prepare("UPDATE keys SET status = 'banned' WHERE id = ?").run(row.id);
    logExecution({ ...ctx, keyId: row.id, success: false, reason: shared });
    return { success: false, code: 403, message: 'Key banned — sharing detected' };
  }

  // Success — record the execution and hand back the protected source.
  db.prepare('UPDATE keys SET total_executions = total_executions + 1, last_seen = ? WHERE id = ?').run(now(), row.id);
  logExecution({ ...ctx, keyId: row.id, success: true, reason: 'ok' });

  const result = { success: true, version: script.version, expires_at: row.expires_at };

  if (!script.obfuscate) {
    result.script = script.source;
    return result;
  }

  // Session mode: encrypt under a key derived from this handshake. It is never
  // put in the payload — the loader derives the same value locally — so the
  // response is useless to anyone who didn't run this exact session.
  const useSession = config.antiTamper && config.sessionEncryption && session && session.salt;
  if (useSession) {
    const derived = sessionKey({
      salt: session.salt,
      nonce: session.nonce,
      scriptId,
      key,
      hwid: hwid || '',
    });
    result.script = obfuscate(script, { key: derived, keyId: row.id });
    result.enc = 'session';
  } else {
    result.script = obfuscate(script, { keyId: row.id });
  }
  return result;
}

/** True if this key already used up its allowance of successful auths in the window. */
function keyThrottled(keyId) {
  if (!config.keyRateMax || config.keyRateMax < 1) return false;
  const since = now() - Math.floor(config.keyRateWindowMs / 1000);
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM executions WHERE key_id = ? AND success = 1 AND created_at >= ?')
    .get(keyId, since);
  return row.n >= config.keyRateMax;
}

/**
 * Reason string if honoring a request from `hwid`/`ip` would exceed the allowed
 * number of distinct devices or networks for this key within the window, else null.
 *
 * The caller's own HWID/IP is counted even though this request hasn't been logged
 * yet, so the limit is enforced on the offending request itself rather than one
 * execution late. Only successful executions count, so someone who merely knows a
 * key can't get it banned by spraying junk HWIDs at it.
 */
function sharingViolation(keyId, { hwid, ip }) {
  const maxHwids = config.keyShareMaxHwids;
  const maxIps = config.keyShareMaxIps;
  if (maxHwids < 1 && maxIps < 1) return null;

  const since = now() - Math.floor(config.keyShareWindowMs / 1000);
  const rows = db
    .prepare(
      `SELECT DISTINCT hwid, ip FROM executions
       WHERE key_id = ? AND success = 1 AND created_at >= ?`
    )
    .all(keyId, since);

  if (maxHwids >= 1) {
    const seen = new Set(rows.map((r) => r.hwid).filter(Boolean));
    if (hwid) seen.add(String(hwid));
    if (seen.size > maxHwids) return 'auto_banned_sharing';
  }
  if (maxIps >= 1) {
    const seen = new Set(rows.map((r) => r.ip).filter(Boolean));
    if (ip) seen.add(String(ip));
    if (seen.size > maxIps) return 'auto_banned_sharing_ip';
  }
  return null;
}

/**
 * Record a tamper signal the loader reported from the client. Advisory only —
 * the report is trivially forgeable, so it is logged (and optionally counted
 * toward an auto-ban) but never trusted to unlock anything.
 */
function reportTamper({ scriptId, key, hwid, ip, executor, reason }) {
  const script = getScript(scriptId);
  if (!script) return { success: false, code: 404, message: 'Script not found' };

  const row = key ? db.prepare('SELECT id FROM keys WHERE value = ? AND script_id = ?').get(key, scriptId) : null;
  const tag = `client_tamper:${
    String(reason || 'unknown')
      .replace(/[^a-z0-9:_-]/gi, '')
      .slice(0, 32) || 'unknown'
  }`;

  logExecution({
    keyId: row ? row.id : null,
    scriptId,
    hwid,
    ip,
    executor: cleanExecutor(executor),
    success: false,
    reason: tag,
  });

  if (row && config.tamperReportBan >= 1) {
    const since = now() - Math.floor(config.keyShareWindowMs / 1000);
    const seen = db
      .prepare(
        `SELECT COUNT(*) AS n FROM executions
         WHERE key_id = ? AND created_at >= ? AND reason LIKE 'client_tamper:%'`
      )
      .get(row.id, since);
    if (seen.n >= config.tamperReportBan) {
      db.prepare("UPDATE keys SET status = 'banned' WHERE id = ?").run(row.id);
    }
  }

  return { success: true };
}

/**
 * Record a protocol violation the server established itself, and auto-ban the
 * key once they pile up (PROTOCOL_BAN, 0 = off).
 *
 * These are the opposite of the client reports above: a stock loader takes a
 * fresh nonce, spends it once, straight away, from the same IP, carrying an
 * HMAC only that session's salt produces. Every reason routed here is therefore
 * something no legitimate client can do — which is what makes it safe to ban on
 * and, unlike a report, impossible for an outsider to fake against someone
 * else's key: it takes the key's own live session to even reach this code.
 *
 * @param {{scriptId:string, key?:string|null, hwid?:string|null, ip?:string|null,
 *          executor?:string|null, reason:string}} args
 * @returns {{banned:boolean, count:number}}
 */
function recordViolation({ scriptId, key, hwid, ip, executor, reason }) {
  const row = key ? db.prepare('SELECT id FROM keys WHERE value = ? AND script_id = ?').get(key, scriptId) : null;
  const tag = `protocol:${String(reason || 'unknown').replace(/[^a-z0-9:_-]/gi, '').slice(0, 32) || 'unknown'}`;

  logExecution({
    keyId: row ? row.id : null,
    scriptId,
    hwid,
    ip,
    executor: cleanExecutor(executor),
    success: false,
    reason: tag,
  });

  // Nothing to count against without a key — the violation is still on record.
  if (!row || config.protocolBan < 1) return { banned: false, count: 0 };

  const since = now() - Math.floor(config.keyShareWindowMs / 1000);
  const seen = db
    .prepare(
      `SELECT COUNT(*) AS n FROM executions
       WHERE key_id = ? AND created_at >= ? AND reason LIKE 'protocol:%'`
    )
    .get(row.id, since);

  if (seen.n >= config.protocolBan) {
    db.prepare("UPDATE keys SET status = 'banned' WHERE id = ?").run(row.id);
    return { banned: true, count: seen.n };
  }
  return { banned: false, count: seen.n };
}

module.exports = { authenticate, reportTamper, recordViolation, cleanExecutor, checkHwid, HWID_RE };
