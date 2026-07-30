'use strict';

const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const port = parseInt(process.env.PORT || '3000', 10);

const config = {
  env: process.env.NODE_ENV || 'development',
  port,
  // Bind address. In production (behind nginx) set HOST=127.0.0.1 so the app
  // is not reachable directly from the internet.
  host: process.env.HOST || '0.0.0.0',
  baseUrl: (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  adminApiKey: process.env.ADMIN_API_KEY || '',
  keyPrefix: process.env.KEY_PREFIX || '2t1',
  dbPath: process.env.DB_PATH
    ? path.resolve(process.cwd(), process.env.DB_PATH)
    : path.join(__dirname, '..', 'data', '2t1auth.db'),
  authRateMax: parseInt(process.env.AUTH_RATE_MAX || '30', 10),
  authRateWindowMs: parseInt(process.env.AUTH_RATE_WINDOW_MS || '60000', 10),

  // Executors that are refused at /api/v1/auth (comma-separated, case-insensitive).
  blockedExecutors: (process.env.BLOCKED_EXECUTORS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  // If non-empty, ONLY these executors are allowed (allowlist wins over denylist).
  allowedExecutors: (process.env.ALLOWED_EXECUTORS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  // Anti-tamper: require a fresh single-use nonce (handshake) before auth.
  antiTamper: process.env.ANTI_TAMPER !== '0',
  nonceTtlMs: parseInt(process.env.NONCE_TTL_MS || '20000', 10),
  // Key-sharing: auto-ban a key seen from more than N distinct HWIDs in the window (0 = off).
  keyShareMaxHwids: parseInt(process.env.KEY_SHARE_MAX_HWIDS || '0', 10),
  keyShareWindowMs: parseInt(process.env.KEY_SHARE_WINDOW_MS || '3600000', 10),

  // Dashboard session
  cookieName: '_2t1_sess',
  sessionMaxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};

config.isProd = config.env === 'production';

// Secret used to sign session cookies. Prefer an explicit SESSION_SECRET;
// otherwise derive one from the admin key so sessions survive restarts.
config.sessionSecret =
  process.env.SESSION_SECRET ||
  (config.adminApiKey
    ? crypto.createHash('sha256').update('2t1sess:' + config.adminApiKey).digest('hex')
    : crypto.randomBytes(32).toString('hex'));

// Only mark cookies Secure when actually served over HTTPS (else localhost breaks).
config.cookieSecure = config.baseUrl.startsWith('https');

// Whether SESSION_SECRET was explicitly provided (vs derived) — used by config checks.
config.hasExplicitSessionSecret = !!process.env.SESSION_SECRET;

module.exports = config;
