'use strict';

function notFound(req, res) {
  res.status(404).json({ success: false, message: 'Not found' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error('[2t1auth] error:', err.stack || err.message);
  const status = err.status || 500;
  res.status(status).json({
    success: false,
    message: err.expose ? err.message : 'Internal server error',
  });
}

module.exports = { notFound, errorHandler };
