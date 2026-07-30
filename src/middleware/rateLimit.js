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

// Tamper reports are unauthenticated and write a row each — keep them to a
// trickle so nobody can flood the executions table with noise.
const reportLimiter = rateLimit({
  windowMs: config.authRateWindowMs,
  max: Math.max(5, Math.floor(config.authRateMax / 3)),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, slow down.' },
});

module.exports = { authLimiter, reportLimiter };
