-- 2t1auth database schema

CREATE TABLE IF NOT EXISTS scripts (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  source              TEXT NOT NULL DEFAULT '',
  version             TEXT NOT NULL DEFAULT '1.0.0',
  hwid_lock           INTEGER NOT NULL DEFAULT 1,   -- 1 = bind key to first HWID seen
  hwid_reset_cooldown INTEGER NOT NULL DEFAULT 86400, -- seconds between user self-resets
  hwid_reset_limit    INTEGER NOT NULL DEFAULT 3,    -- max resets before manual intervention
  obfuscate           INTEGER NOT NULL DEFAULT 1,    -- 1 = encrypt/obfuscate on delivery
  enabled             INTEGER NOT NULL DEFAULT 1,    -- 0 = maintenance mode (auth rejected)
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS keys (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  value            TEXT NOT NULL UNIQUE,
  script_id        TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  hwid             TEXT,                             -- bound hardware id (NULL until first use)
  status           TEXT NOT NULL DEFAULT 'active',   -- active | banned | paused
  note             TEXT NOT NULL DEFAULT '',
  discord_id       TEXT,
  expires_at       INTEGER,                          -- epoch seconds, NULL = lifetime
  hwid_reset_count INTEGER NOT NULL DEFAULT 0,
  last_hwid_reset  INTEGER,
  total_executions INTEGER NOT NULL DEFAULT 0,
  last_seen        INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_keys_value  ON keys(value);
CREATE INDEX IF NOT EXISTS idx_keys_script ON keys(script_id);

CREATE TABLE IF NOT EXISTS executions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id     INTEGER REFERENCES keys(id) ON DELETE SET NULL,
  script_id  TEXT,
  hwid       TEXT,
  ip         TEXT,
  executor   TEXT,
  success    INTEGER NOT NULL,
  reason     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exec_script  ON executions(script_id);
CREATE INDEX IF NOT EXISTS idx_exec_created ON executions(created_at);
-- Hot path: the key throttle and the key-sharing check both scan a single key's
-- recent rows on EVERY auth. Without this they fall back to idx_exec_created and
-- walk the whole window — ~114ms per auth at 300k rows vs ~0.06ms with it.
CREATE INDEX IF NOT EXISTS idx_exec_key_time ON executions(key_id, created_at);

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS resellers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  credits       INTEGER NOT NULL DEFAULT 0,   -- 1 credit = 1 generated key
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

-- which scripts a reseller may sell keys for
CREATE TABLE IF NOT EXISTS reseller_scripts (
  reseller_id INTEGER NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
  script_id   TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  PRIMARY KEY (reseller_id, script_id)
);
