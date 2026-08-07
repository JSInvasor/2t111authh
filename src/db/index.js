'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

// Make sure the folder for the database file exists.
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Wait up to 5s instead of erroring if another process (e.g. the Discord bot)
// holds a write lock. WAL + busy_timeout makes multi-process access robust.
db.pragma('busy_timeout = 5000');

// Apply the schema (idempotent — uses IF NOT EXISTS everywhere).
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Lightweight migrations for columns added after the initial release.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('scripts', 'obfuscate', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('scripts', 'enabled', 'INTEGER NOT NULL DEFAULT 1');
// Reseller who created a key (NULL = created by admin). Plain column; cleanup handled in code.
ensureColumn('keys', 'reseller_id', 'INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS idx_keys_reseller ON keys(reseller_id)');

// Bumped on every password change; session tokens carry the value they were
// issued under, so changing a password invalidates the sessions that predate it.
ensureColumn('admins', 'token_version', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('resellers', 'token_version', 'INTEGER NOT NULL DEFAULT 0');

// Exactly one admin owns the install and may manage the others. On a database
// that predates the flag, the oldest admin gets it — that is the account the
// operator set up first, and leaving nobody as owner would mean nobody could
// ever create an admin from the dashboard.
ensureColumn('admins', 'is_owner', 'INTEGER NOT NULL DEFAULT 0');
{
  const hasOwner = db.prepare('SELECT COUNT(*) AS n FROM admins WHERE is_owner = 1').get().n;
  if (!hasOwner) {
    const first = db.prepare('SELECT id FROM admins ORDER BY id LIMIT 1').get();
    if (first) db.prepare('UPDATE admins SET is_owner = 1 WHERE id = ?').run(first.id);
  }
}

// Device identity beyond the executor's client id, which has public spoofers.
// device_token is a random value the loader persists to the executor's own
// filesystem: it survives a spoofed client id and a reinstall of the game, and
// is lost only when the user wipes the executor's workspace.
ensureColumn('keys', 'device_token', 'TEXT');
// Hash of what the client's environment looked like the first time this key
// authenticated (trust on first use). A change means hooks appeared, the
// executor was swapped, or someone else is using the key.
ensureColumn('keys', 'env_fp', 'TEXT');
ensureColumn('keys', 'env_fp_changes', 'INTEGER NOT NULL DEFAULT 0');

// keyHash() of the key value — how a loader names its key on the wire without
// sending it. Backfilled here so databases created before the mutual-auth
// protocol keep working without a manual migration step.
ensureColumn('keys', 'kh', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_keys_kh ON keys(kh)');
{
  const stale = db.prepare('SELECT id, value FROM keys WHERE kh IS NULL').all();
  if (stale.length) {
    const { keyHash } = require('../utils/crypto');
    const setKh = db.prepare('UPDATE keys SET kh = ? WHERE id = ?');
    db.transaction(() => {
      for (const row of stale) setKh.run(keyHash(row.value), row.id);
    })();
  }
}

module.exports = db;
