const express = require('express');
const healthRoutes = require('./routes/health');
const authRoutes = require('./routes/auth');
const companiesRoutes = require('./routes/companies');
const jobsRoutes = require('./routes/jobs');
const adminRoutes = require('./routes/admin');
const authMiddleware = require('./middleware/auth');
const errorHandler = require('./middleware/errorHandler');

function createApp(queues = {}) {
  const app = express();
  app.use(express.json());

  // Make queues available to routes
  if (queues.crawlQueue) app.set('crawlQueue', queues.crawlQueue);
  if (queues.syncQueue) app.set('syncQueue', queues.syncQueue);

  // Public routes (no auth)
  app.use(healthRoutes);
  app.use(authRoutes);

  // Protected routes
  app.use(authMiddleware);
  app.use(companiesRoutes);
  app.use(jobsRoutes);
  app.use(adminRoutes);

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
