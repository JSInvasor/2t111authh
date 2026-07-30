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

module.exports = { authLimiter };
