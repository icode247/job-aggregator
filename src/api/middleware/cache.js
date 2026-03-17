const { createRedisConnection } = require('../../queues/connection');
const logger = require('../../logger');

let redis = null;

function getRedis() {
  if (!redis) {
    try { redis = createRedisConnection(); } catch { return null; }
  }
  return redis;
}

function cacheMiddleware(ttlSeconds = 60) {
  return async (req, res, next) => {
    if (req.method !== 'GET') return next();
    const client = getRedis();
    if (!client) return next();

    // Only cache simple routes, skip high-cardinality search queries
    const path = req.path;
    if (path.startsWith('/api/jobs') && req.query.q) {
      // Don't cache search queries — too many unique combinations fill Redis
      return next();
    }

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
