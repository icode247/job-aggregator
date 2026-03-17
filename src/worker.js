const logger = require('./logger');
const { migrate, closeDb } = require('./db');
const metrics = require('./utils/metrics');
const { createRedisConnection } = require('./queues/connection');
const { createDiscoveryQueue, createDiscoveryWorker } = require('./queues/discovery.queue');
const { createSyncQueue, createSyncWorker } = require('./queues/sync.queue');
const { createCrawlQueue, createCrawlWorker } = require('./queues/crawl.queue');
const { registerSchedules, fanoutDiscovery, fanoutSync, fanoutCrawl } = require('./queues/scheduler');
const { backfillDescriptions } = require('./tasks/backfill-descriptions');

async function main() {
  await migrate();
  metrics.setRedis(createRedisConnection());

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

  // Stagger fanout to avoid boot-time spike
  setTimeout(() => fanoutDiscovery(discoveryQueue).catch(e => logger.error({ err: e.message }, 'Discovery fanout error')), 30000);
  setTimeout(() => fanoutSync(syncQueue).catch(e => logger.error({ err: e.message }, 'Sync fanout error')), 60000);
  setTimeout(() => fanoutCrawl(crawlQueue).catch(e => logger.error({ err: e.message }, 'Crawl fanout error')), 90000);

  logger.info('Worker started — processing discovery, sync, and crawl queues');

  // Backfill descriptions for all ATS platforms every 10 minutes (with overlap guard)
  let allBackfillRunning = false;
  async function runAllBackfill() {
    if (allBackfillRunning) { logger.warn('All-ATS backfill still running, skipping'); return; }
    allBackfillRunning = true;
    try {
      await backfillDescriptions();
    } catch (err) {
      logger.error({ err: err.message }, 'Description backfill error');
    } finally {
      allBackfillRunning = false;
    }
    const jitter = Math.floor(Math.random() * 120000);
    setTimeout(runAllBackfill, 10 * 60 * 1000 + jitter);
  }
  setTimeout(runAllBackfill, 3 * 60 * 1000); // Start 3 minutes after boot

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
