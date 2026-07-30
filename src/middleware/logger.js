'use strict';

const config = require('../config');

// Minimal structured request logger (no dependency). Silent during tests.
module.exports = function requestLogger(req, res, next) {
  if (config.env === 'test') return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '-').toString().split(',')[0].trim();
    console.log(
      `[2t1auth] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms ${ip}`
    );
  });
  next();
};
