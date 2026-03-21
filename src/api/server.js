const express = require('express');
const healthRoutes = require('./routes/health');
const authRoutes = require('./routes/auth');
const companiesRoutes = require('./routes/companies');
const jobsRoutes = require('./routes/jobs');
const adminRoutes = require('./routes/admin');
const metricsRoutes = require('./routes/metrics');
const authMiddleware = require('./middleware/auth');
const { cacheMiddleware } = require('./middleware/cache');
const errorHandler = require('./middleware/errorHandler');
const metrics = require('../utils/metrics');

function createApp(queues = {}) {
  const app = express();
  app.use(express.json());

  // CORS — only allow specific origins
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const isAllowed = origin && (
      origin === 'http://localhost:3000' ||
      origin === 'http://localhost:3001' ||
      /^https:\/\/([a-z0-9-]+\.)*fastapply\.co$/.test(origin)
    );
    if (isAllowed) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.set('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Response time tracking
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      metrics.timing(`api.${req.method}.${req.route?.path || req.path}`, duration);
      metrics.increment('api.requests');
    });
    next();
  });

  // Make queues available to routes
  if (queues.crawlQueue) app.set('crawlQueue', queues.crawlQueue);
  if (queues.syncQueue) app.set('syncQueue', queues.syncQueue);

  // Public routes (no auth)
  app.use(healthRoutes);
  app.use(authRoutes);

  // Protected routes
  app.use(authMiddleware);
  app.use(cacheMiddleware(300));
  app.use(companiesRoutes);
  app.use(jobsRoutes);
  app.use(adminRoutes);
  app.use(metricsRoutes);

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
