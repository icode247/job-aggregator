const logger = require('./logger');
const { migrate, closeDb } = require('./db');
const { createDiscoveryQueue, createDiscoveryWorker } = require('./queues/discovery.queue');
const { createSyncQueue, createSyncWorker } = require('./queues/sync.queue');
const { createCrawlQueue, createCrawlWorker } = require('./queues/crawl.queue');
const { registerSchedules, fanoutDiscovery, fanoutSync, fanoutCrawl } = require('./queues/scheduler');

async function main() {
  await migrate();

  const discoveryQueue = createDiscoveryQueue();
  const syncQueue = createSyncQueue();
  const crawlQueue = createCrawlQueue();

  const discoveryWorker = createDiscoveryWorker(syncQueue);
  const syncWorker = createSyncWorker();
  const crawlWorker = createCrawlWorker(syncQueue);

  discoveryWorker.on('completed', async (job) => {
    if (job.data.fanout) await fanoutDiscovery(discoveryQueue);
  });

  syncWorker.on('completed', async (job) => {
    if (job.data.fanout) await fanoutSync(syncQueue);
  });

  crawlWorker.on('completed', async (job) => {
    if (job.data.fanout) await fanoutCrawl(crawlQueue);
  });

  await registerSchedules(discoveryQueue, syncQueue, crawlQueue);

  await fanoutDiscovery(discoveryQueue);
  await fanoutSync(syncQueue);

  logger.info('Worker started — processing discovery, sync, and crawl queues');

  async function shutdown(signal) {
    logger.info({ signal }, 'Shutting down worker');
    await crawlWorker.close();
    await discoveryWorker.close();
    await syncWorker.close();
    await crawlQueue.close();
    await discoveryQueue.close();
    await syncQueue.close();
    await closeDb();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    logger.error({ err: err?.message }, 'Unhandled rejection in worker');
  });
}

main().catch((err) => {
  logger.fatal({ err: err.message }, 'Worker failed to start');
  process.exit(1);
});
