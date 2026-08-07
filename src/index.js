'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const config = require('./config');
const { enforceConfig } = require('./validateConfig');

const db = require('./db'); // open the database & apply schema on boot

const { requireAdmin, requireReseller } = require('./middleware/auth');
const requestLogger = require('./middleware/logger');
const { notFound, errorHandler } = require('./middleware/error');
const publicRouter = require('./routes/loader');
const dashboardRouter = require('./routes/dashboard');
const scriptsRouter = require('./routes/scripts');
const keysRouter = require('./routes/keys');
const resellersRouter = require('./routes/resellers');
const resellerRouter = require('./routes/reseller');
const { overview } = require('./services/stats');
const retention = require('./services/retention');
const audit = require('./services/audit');
const backup = require('./services/backup');

// Fail fast (in production) on an insecure/incomplete configuration.
enforceConfig();

// Fold old execution rows into the daily rollup on a timer, so the table the
// hot path reads stays small instead of growing for the life of the install.
retention.start();

// Verified backups on a timer. Set BACKUP_INTERVAL_MS=0 when cron owns the
// schedule instead (see DEPLOY.md), so they don't run twice.
backup.start();

const app = express();

// Respect X-Forwarded-For when behind a reverse proxy (nginx, Cloudflare…).
// TRUST_PROXY must match the real number of proxies: too high and a client can
// forge its own IP, dodging the rate limiter and the handshake's IP binding.
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        scriptSrc: ["'self'"],
        // Don't force https on subresources — it breaks the http://localhost dashboard.
        upgradeInsecureRequests: null,
      },
    },
  })
);
app.use(requestLogger);

// Body parsers, scoped by trust level. Unauthenticated/public routes get a
// tight limit; only the admin script routes (which carry Lua source) get the
// large one. Applied per-mount below — no global parser — so a public endpoint
// can never be forced to buffer a multi-megabyte body.
const jsonSmall = express.json({ limit: '64kb' });
const jsonLarge = express.json({ limit: config.jsonLimit });

// Health check (also verifies the DB is reachable).
app.get('/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', uptime: process.uptime() });
  } catch {
    res.status(503).json({ status: 'degraded' });
  }
});

// Dashboard (web UI + its auth endpoints). Order matters: API before static.
app.get('/', (req, res) => res.redirect('/dashboard/'));
// Redirect the no-trailing-slash form only, so relative asset URLs resolve
// under /dashboard/ (an exact match avoids a redirect loop on /dashboard/).
app.use((req, res, next) => (req.path === '/dashboard' ? res.redirect('/dashboard/') : next()));
app.use('/dashboard/api', jsonSmall, dashboardRouter);
app.use(
  '/dashboard',
  express.static(path.join(__dirname, '..', 'public'), {
    // Revalidate via ETag every load so dashboard updates aren't masked by cache.
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  })
);

// Public: Lua loader delivery + auth endpoint
app.use(publicRouter);

// Admin API (Bearer master key OR admin session cookie)
app.get('/api/v1/overview', requireAdmin, (req, res) => res.json({ success: true, overview: overview() }));
// Who did what. Admin-only: a reseller must not be able to read (or audit) the
// trail that exists to hold them to account.
app.get('/api/v1/audit', requireAdmin, (req, res) =>
  res.json({
    success: true,
    entries: audit.list({
      targetType: req.query.target_type || null,
      targetId: req.query.target_id || null,
      limit: req.query.limit,
    }),
  })
);
app.use('/api/v1/scripts', requireAdmin, jsonLarge, scriptsRouter); // script source can be large
app.use('/api/v1/keys', requireAdmin, jsonSmall, keysRouter);
app.use('/api/v1/resellers', requireAdmin, jsonSmall, resellersRouter);

// Reseller-scoped API (reseller session cookie)
app.use('/api/v1/reseller', requireReseller, jsonSmall, resellerRouter);

app.use(notFound);
app.use(errorHandler);

const server = app.listen(config.port, config.host, () => {
  console.log(`[2t1auth] listening on ${config.host}:${config.port} (public: ${config.baseUrl})`);
  console.log(`[2t1auth] dashboard: ${config.baseUrl}/dashboard/`);
});

// Graceful shutdown (systemd sends SIGTERM on stop/restart).
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[2t1auth] ${signal} received, shutting down…`);
  server.close(() => {
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  });
  // Don't hang forever if connections are stuck.
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server };
