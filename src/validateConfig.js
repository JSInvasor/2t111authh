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
