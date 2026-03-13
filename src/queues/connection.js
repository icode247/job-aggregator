const IORedis = require('ioredis');
const config = require('../config');

function createRedisConnection() {
  const opts = {
    maxRetriesPerRequest: null, // Required by BullMQ
  };

  if (config.NODE_ENV === 'production') {
    opts.tls = { rejectUnauthorized: false };
  }

  return new IORedis(config.REDIS_URL, opts);
}

module.exports = { createRedisConnection };
