'use strict';

// Database backup, and — the part that actually matters — verification.
//
// Losing this file is a specific kind of disaster for a licensing system: every
// customer is locked out at the same moment, AND the record of who bought what
// is gone, so you cannot even put it back by hand. DEPLOY.md documented a backup
// command, which is not the same as having backups: nothing ran it on a
// schedule, and nothing had ever restored from one.
//
// So every backup here is opened and read back before it counts as a backup. An
// untested backup is not a backup, it is an assumption.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../db');
const config = require('../config');

const STAMP = () => new Date().toISOString().replace(/[:.]/g, '-');

/** Tables whose emptiness would mean the backup is useless even if it is valid. */
const MUST_SURVIVE = ['scripts', 'keys', 'admins'];

/**
 * Open a backup file and prove it is actually usable: structurally sound, and
 * carrying the data it is supposed to carry.
 *
 * @param {string} file
 * @param {{expect?:Record<string, number>}} [opts] row counts the source had
 * @returns {{ok:true, counts:object} | {ok:false, reason:string}}
 */
function verify(file, { expect = null } = {}) {
  if (!fs.existsSync(file)) return { ok: false, reason: `missing: ${file}` };

  let copy;
  try {
    copy = new Database(file, { readonly: true, fileMustExist: true });
  } catch (err) {
    return { ok: false, reason: `unreadable: ${err.message}` };
  }

  try {
    const integrity = copy.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') return { ok: false, reason: `integrity_check: ${integrity}` };

    const counts = {};
    for (const table of MUST_SURVIVE) {
      counts[table] = copy.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    }
    // A syntactically perfect empty file passes integrity_check happily, so
    // compare against what the source actually held.
    if (expect) {
      for (const [table, n] of Object.entries(expect)) {
        if (counts[table] !== n) {
          return { ok: false, reason: `${table}: backup has ${counts[table]}, source had ${n}` };
        }
      }
    }
    return { ok: true, counts };
  } catch (err) {
    return { ok: false, reason: `query failed: ${err.message}` };
  } finally {
    copy.close();
  }
}

/** Row counts in the live database, for comparison against a fresh backup. */
function sourceCounts() {
  const out = {};
  for (const table of MUST_SURVIVE) {
    out[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  }
  return out;
}

/**
 * Take an online backup (safe while the server is serving), verify it, and prune
 * old ones. A backup that fails verification is deleted rather than left to look
 * like a good one.
 *
 * @returns {Promise<{file:string, bytes:number, counts:object, pruned:string[]}>}
 */
async function run({ dir = config.backupDir, keep = config.backupKeep } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2t1auth-${STAMP()}.db`);

  const expect = sourceCounts();
  await db.backup(file);

  const check = verify(file, { expect });
  if (!check.ok) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* nothing more we can do */
    }
    throw new Error(`backup failed verification (${check.reason})`);
  }

  return { file, bytes: fs.statSync(file).size, counts: check.counts, pruned: prune(dir, keep) };
}

/** Keep the newest `keep` backups, delete the rest. Returns what it removed. */
function prune(dir = config.backupDir, keep = config.backupKeep) {
  if (!fs.existsSync(dir) || keep < 1) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^2t1auth-.*\.db$/.test(f))
    .sort()
    .reverse();

  const doomed = files.slice(keep);
  for (const f of doomed) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      /* leave it; the next sweep will try again */
    }
  }
  return doomed;
}

/** Newest backup on disk, or null. */
function latest(dir = config.backupDir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^2t1auth-.*\.db$/.test(f))
    .sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

/** Start the periodic backup. Unref'd, so it never holds the process open. */
function start() {
  if (!config.backupIntervalMs) return null;
  const timer = setInterval(() => {
    run().then(
      (out) => console.log(`[2t1auth] backup ok: ${out.file} (${out.bytes} bytes)`),
      (err) => console.error('[2t1auth] BACKUP FAILED:', err.message)
    );
  }, config.backupIntervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { run, verify, prune, latest, sourceCounts, start, MUST_SURVIVE };
