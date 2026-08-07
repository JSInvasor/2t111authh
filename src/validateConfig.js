'use strict';

const config = require('./config');

const DEFAULT_KEY = 'change-me-to-a-long-random-string';

/**
 * Inspect the loaded config and classify problems.
 * In production, `errors` should stop the process from booting.
 * @returns {{ errors: string[], warnings: string[] }}
 */
function checkConfig() {
  const errors = [];
  const warnings = [];
  const prod = config.isProd;

  if (!config.adminApiKey || config.adminApiKey === DEFAULT_KEY) {
    (prod ? errors : warnings).push('ADMIN_API_KEY is missing or still the default value.');
  } else if (config.adminApiKey.length < 24) {
    warnings.push('ADMIN_API_KEY is short (<24 chars). Use a 64-char random hex.');
  }

  if (!config.hasExplicitSessionSecret) {
    (prod ? errors : warnings).push(
      'SESSION_SECRET is not set. Sessions will not survive restarts (and are weak if ADMIN_API_KEY is default).'
    );
  }

  if (prod && !config.baseUrl.startsWith('https://')) {
    errors.push(`BASE_URL must use https in production (got "${config.baseUrl}"). Secure cookies require it.`);
  }

  if (prod && config.host === '0.0.0.0') {
    warnings.push('HOST is 0.0.0.0; when running behind nginx set HOST=127.0.0.1 so the app is not exposed directly.');
  }

  // ---- anti-tamper ----
  if (!config.antiTamper) {
    (prod ? errors : warnings).push(
      'ANTI_TAMPER=0 — the handshake, session proof and session-keyed delivery are all off. Debug only.'
    );
  } else {
    if (!config.requireProof) {
      warnings.push('REQUIRE_PROOF=0 — captured auth requests can be edited and replayed with a fresh nonce.');
    }
    if (!config.sessionEncryption) {
      warnings.push('SESSION_ENCRYPTION=0 — delivered payloads carry their own key, so a captured response decrypts.');
    }
    if (!config.nonceBindIp) {
      warnings.push('NONCE_BIND_IP=0 — a handshake taken on one host can be spent from another.');
    }
  }

  // Handshakes and leases live in this process's memory. Run a second instance
  // and a handshake opened on one is unknown to the other, so auth fails with
  // "invalid or expired session" for a fraction of users — the kind of failure
  // that looks random and gets blamed on everything except the deploy topology.
  // Catch the common ways of ending up multi-instance rather than letting it be
  // discovered in production.
  const instance = parseInt(process.env.NODE_APP_INSTANCE ?? process.env.pm_id ?? '', 10);
  const instances = parseInt(process.env.instances ?? process.env.WEB_CONCURRENCY ?? '', 10);
  if (Number.isFinite(instance) && instance > 0) {
    errors.push(
      `This is instance ${instance} of a multi-process deployment, but handshake and lease state is per-process. ` +
        'Run a single instance (scale with a bigger box, not more workers) until a shared store is added.'
    );
  } else if (Number.isFinite(instances) && instances > 1) {
    errors.push(
      `${instances} workers are configured, but handshake and lease state is per-process — auth will fail ` +
        'intermittently. Run a single instance until a shared store is added.'
    );
  }

  if (prod && config.trustProxy > 0 && config.host === '0.0.0.0') {
    warnings.push(
      `TRUST_PROXY=${config.trustProxy} while listening on 0.0.0.0 — if clients can reach the app directly they can forge X-Forwarded-For and bypass rate limiting.`
    );
  }

  return { errors, warnings };
}

/**
 * Print warnings/errors. In production, exit on any error.
 */
function enforceConfig({ logger = console, exit = process.exit } = {}) {
  const { errors, warnings } = checkConfig();
  for (const w of warnings) logger.warn(`[2t1auth] config warning: ${w}`);
  for (const e of errors) logger.error(`[2t1auth] config ERROR: ${e}`);
  if (errors.length && config.isProd) {
    logger.error('[2t1auth] Refusing to start in production with an invalid configuration.');
    exit(1);
  }
  return { errors, warnings };
}

module.exports = { checkConfig, enforceConfig };
