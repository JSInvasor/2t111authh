'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../config');

// Throttle the public auth endpoint so keys can't be brute-forced.
const authLimiter = rateLimit({
  windowMs: config.authRateWindowMs,
  max: config.authRateMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, slow down.' },
});

// Serving a loader is the most expensive unauthenticated thing we do: every hit
// re-renders and re-encrypts the bootstrap from scratch (~2.8ms of CPU, and it
// deliberately cannot be cached because each delivery must be byte-unique). A
// handful of connections would otherwise pin a core and starve /api/v1/auth.
// A genuine user fetches this once per execution, so the ceiling is generous.
const loaderLimiter = rateLimit({
  windowMs: config.loaderRateWindowMs,
  max: config.loaderRateMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: '-- [2t1auth] too many requests, slow down.',
});

// Tamper reports are unauthenticated and write a row each — keep them to a
// trickle so nobody can flood the executions table with noise.
const reportLimiter = rateLimit({
  windowMs: config.authRateWindowMs,
  max: Math.max(5, Math.floor(config.authRateMax / 3)),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, slow down.' },
});

module.exports = { authLimiter, loaderLimiter, reportLimiter };
