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
