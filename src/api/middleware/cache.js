const { createRedisConnection } = require('../../queues/connection');
const logger = require('../../logger');

let redis = null;

function getRedis() {
  // Redis retired (addon removed) — no REDIS_URL means no cache. Returning null makes the
  // middleware a pure passthrough. Without this, ioredis connects to the localhost default
  // and client.get() HANGS forever (maxRetriesPerRequest is null), hanging every API request.
  if (!process.env.REDIS_URL) return null;
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

    // Skip caching for high-cardinality job queries (search, filters)
    const path = req.path;
    if (path.startsWith('/api/jobs')) {
      const hasFilters = req.query.q || req.query.visa || req.query.remote ||
        req.query.experience_level || req.query.work_mode || req.query.location ||
        req.query.employment_type || req.query.company_id || req.query.ats;
      if (hasFilters) return next();
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
