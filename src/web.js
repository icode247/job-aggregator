const config = require('./config');
const logger = require('./logger');
const { migrate, closeDb } = require('./db');
const { createApp } = require('./api/server');
const { createCrawlQueue } = require('./queues/crawl.queue');
const { createSyncQueue } = require('./queues/sync.queue');

async function main() {
  await migrate();

  const crawlQueue = createCrawlQueue();
  const syncQueue = createSyncQueue();

  const app = createApp({ crawlQueue, syncQueue });

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'API server listening');
  });

  async function shutdown(signal) {
    logger.info({ signal }, 'Shutting down API server');
    server.close(async () => {
      await crawlQueue.close();
      await syncQueue.close();
      await closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000);
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
