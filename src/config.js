'use strict';

const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

/**
 * NaN-safe integer env parsing. `parseInt('twenty')` is NaN, and NaN silently
 * poisons everything downstream (e.g. `Date.now() + NaN` makes nonces that never
 * expire, so the store grows without bound). Fall back to the default instead.
 */
function int(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** Boolean env: "0"/"false"/"off"/"no" are false, anything else set is true. */
function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase());
}

/** Comma-separated list → lowercase, de-duplicated, non-empty entries. */
function list(value) {
  return [
    ...new Set(
      String(value || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
}

// 0 is meaningful here — it asks the OS for any free port (used by the tests).
const port = int(process.env.PORT, 3000, { min: 0, max: 65535 });

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
  authRateMax: int(process.env.AUTH_RATE_MAX, 30, { min: 1 }),
  authRateWindowMs: int(process.env.AUTH_RATE_WINDOW_MS, 60000, { min: 1000 }),
  // Serving /loader/<id>.lua re-renders and re-encrypts the bootstrap every time
  // (it must be byte-unique, so it cannot be cached). Bound it so the one public
  // route that does real CPU work can't be used to starve the auth endpoint.
  loaderRateMax: int(process.env.LOADER_RATE_MAX, 20, { min: 1 }),
  loaderRateWindowMs: int(process.env.LOADER_RATE_WINDOW_MS, 60000, { min: 1000 }),

  // Max JSON body for the admin script routes (source uploads can be large).
  // Public endpoints (auth/handshake) are capped much lower, see src/index.js.
  jsonLimit: process.env.JSON_LIMIT || '5mb',

  // Executors that are refused at /api/v1/auth (comma-separated, case-insensitive).
  blockedExecutors: list(process.env.BLOCKED_EXECUTORS),
  // If non-empty, ONLY these executors are allowed (allowlist wins over denylist).
  allowedExecutors: list(process.env.ALLOWED_EXECUTORS),

  // ---------------------------- Anti-tamper ----------------------------
  // Master switch. 0 = no handshake/proof/session-encryption (debug only).
  antiTamper: bool(process.env.ANTI_TAMPER, true),
  nonceTtlMs: int(process.env.NONCE_TTL_MS, 20000, { min: 1000, max: 300000 }),
  // Pin a handshake to the IP that requested it, so a nonce obtained on one host
  // can't be spent on another (blocks handshake-proxying / key resale relays).
  nonceBindIp: bool(process.env.NONCE_BIND_IP, true),
  // Hard cap on live handshakes; oldest are evicted first. Bounds memory even if
  // the rate limiter is bypassed by a distributed flood.
  nonceMax: int(process.env.NONCE_MAX, 50000, { min: 100 }),
  // Concurrent un-spent handshakes a single IP may hold.
  nonceMaxPerIp: int(process.env.NONCE_MAX_PER_IP, 60, { min: 1 }),
  // Require the loader's HMAC proof over the session (nonce|script|key|hwid|executor).
  requireProof: bool(process.env.REQUIRE_PROOF, true),
  // Derive the delivery cipher key from the live session instead of shipping it
  // inside the payload — a captured response is then undecryptable on its own.
  sessionEncryption: bool(process.env.SESSION_ENCRYPTION, true),
  // Serve /loader/<id>.lua as a per-request encrypted stub (no static text to patch).
  obfuscateLoader: bool(process.env.OBFUSCATE_LOADER, true),
  // Accept client-side tamper reports at POST /api/v1/report.
  tamperReports: bool(process.env.TAMPER_REPORTS, true),
  // Auto-ban a key after N client-side tamper reports in the sharing window (0 = off).
  tamperReportBan: int(process.env.TAMPER_REPORT_BAN, 0),

  // ------------------------------ Leases -------------------------------
  // A successful auth opens a live session the loader beats against. Gives
  // revocation that reaches an already-running script, and turns key sharing
  // from a guess about past log rows into "two seats are in use right now".
  heartbeat: bool(process.env.HEARTBEAT, true),
  // How often the loader is told to beat.
  heartbeatIntervalMs: int(process.env.HEARTBEAT_INTERVAL_MS, 60000, { min: 5000, max: 3600000 }),
  // A lease dies this long after its last beat. Keep it a small multiple of the
  // interval so a couple of dropped requests don't kill a healthy session.
  leaseTtlMs: int(process.env.LEASE_TTL_MS, 210000, { min: 10000 }),
  // Concurrent sessions one key may hold. Going over evicts the oldest rather
  // than refusing the newest, so a crashed client can rejoin at once.
  leaseMaxPerKey: int(process.env.LEASE_MAX_PER_KEY, 1, { min: 1 }),

  // Key-sharing: auto-ban a key seen from more than N distinct HWIDs in the window (0 = off).
  keyShareMaxHwids: int(process.env.KEY_SHARE_MAX_HWIDS, 0),
  // …or from more than N distinct IPs in the same window (0 = off). Catches sharing
  // that a spoofed-but-constant HWID would otherwise hide.
  keyShareMaxIps: int(process.env.KEY_SHARE_MAX_IPS, 0),
  keyShareWindowMs: int(process.env.KEY_SHARE_WINDOW_MS, 3600000, { min: 1000 }),
  // Per-key auth throttle: max successful auths per key per window (0 = off).
  keyRateMax: int(process.env.KEY_RATE_MAX, 0),
  keyRateWindowMs: int(process.env.KEY_RATE_WINDOW_MS, 60000, { min: 1000 }),
  // Longest HWID string accepted/stored. Anything longer is rejected outright.
  hwidMaxLength: int(process.env.HWID_MAX_LENGTH, 128, { min: 8, max: 512 }),

  // How many reverse proxies sit in front of us. Express uses this to pick the
  // real client IP out of X-Forwarded-For. Set to 0 when the app is exposed
  // directly, otherwise anyone can forge their IP and dodge the rate limiter.
  trustProxy: int(process.env.TRUST_PROXY, 1, { min: 0, max: 10 }),

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
module.exports._parse = { int, bool, list };
