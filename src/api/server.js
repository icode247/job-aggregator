const express = require('express');
const healthRoutes = require('./routes/health');
const companiesRoutes = require('./routes/companies');
const jobsRoutes = require('./routes/jobs');
const adminRoutes = require('./routes/admin');
const errorHandler = require('./middleware/errorHandler');

function createApp(queues = {}) {
  const app = express();
  app.use(express.json());

  // Make queues available to routes
  if (queues.crawlQueue) app.set('crawlQueue', queues.crawlQueue);
  if (queues.syncQueue) app.set('syncQueue', queues.syncQueue);

  app.use(healthRoutes);
  app.use(companiesRoutes);
  app.use(jobsRoutes);
  app.use(adminRoutes);

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
