const logger = require('../../logger');

function errorHandler(err, req, res, _next) {
  logger.error({ err: err.message, stack: err.stack, path: req.path }, 'Unhandled error');
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
}

module.exports = errorHandler;
