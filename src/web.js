const config = require('./config');
const logger = require('./logger');
const { migrate, closeDb } = require('./db');
const { createApp } = require('./api/server');

async function main() {
  // Bind port IMMEDIATELY to avoid Heroku H20 boot timeout
  const app = createApp();
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'API server listening');
  });

  // Run migrations after port is bound (non-blocking)
  migrate().catch(err => logger.error({ err: err.message }, 'Migration error'));

  // Connect sync queue lazily (non-blocking)
  let syncQueue = null;
  setImmediate(async () => {
    try {
      const { createSyncQueue } = require('./queues/sync.queue');
      syncQueue = createSyncQueue();
      app.set('syncQueue', syncQueue);
      logger.info('Queue connection established');
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to connect queue (non-fatal)');
    }
  });

  async function shutdown(signal) {
    logger.info({ signal }, 'Shutting down API server');
    const forceTimer = setTimeout(() => process.exit(1), 10000);
    forceTimer.unref();
    server.close(async () => {
      try {
        if (syncQueue) await syncQueue.close();
        await closeDb();
      } catch { /* ignore */ }
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    logger.error({ err: err?.message }, 'Unhandled rejection');
  });
}

main().catch((err) => {
  logger.fatal({ err: err.message }, 'Web server failed to start');
  process.exit(1);
});
