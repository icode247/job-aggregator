const { createRedisConnection } = require('../../queues/connection');
const logger = require('../../logger');

let redis = null;

function getRedis() {
  if (!redis) {
    try { redis = createRedisConnection(); } catch { return null; }
  }
  return redis;
}

function cacheMiddleware(ttlSeconds = 300) {
  return async (req, res, next) => {
    if (req.method !== 'GET') return next();
    const client = getRedis();
    if (!client) return next();

    const key = `cache:${req.originalUrl}`;
    try {
      const cached = await client.get(key);
      if (cached) {
        res.set('X-Cache', 'HIT');
        res.set('Cache-Control', `public, max-age=${ttlSeconds}`);
        return res.json(JSON.parse(cached));
      }
    } catch { /* cache miss */ }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      try {
        client.setex(key, ttlSeconds, JSON.stringify(body)).catch(() => {});
      } catch { /* ignore cache write errors */ }
      res.set('X-Cache', 'MISS');
      res.set('Cache-Control', `public, max-age=${ttlSeconds}`);
      return originalJson(body);
    };
    next();
  };
}

module.exports = { cacheMiddleware };
