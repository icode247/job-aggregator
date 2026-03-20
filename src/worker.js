const logger = require('./logger');
const { migrate, closeDb } = require('./db');
const metrics = require('./utils/metrics');
const { createRedisConnection } = require('./queues/connection');
const { createDiscoveryQueue, createDiscoveryWorker } = require('./queues/discovery.queue');
const { createSyncQueue, createSyncWorker } = require('./queues/sync.queue');
const { createCrawlQueue, createCrawlWorker } = require('./queues/crawl.queue');
const { registerSchedules, fanoutDiscovery, fanoutSync, fanoutCrawl } = require('./queues/scheduler');
const { backfillDescriptions } = require('./tasks/backfill-descriptions');
const { backfillClassifications } = require('./tasks/backfill-classifications');

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

  // Clean stale jobs to free Redis memory
  await Promise.allSettled([
    syncQueue.drain().catch(() => {}),
    syncQueue.clean(0, 1000, 'completed'),
    syncQueue.clean(0, 1000, 'failed'),
    discoveryQueue.clean(0, 500, 'completed'),
    discoveryQueue.clean(0, 500, 'failed'),
    crawlQueue.clean(0, 500, 'completed'),
    crawlQueue.clean(0, 500, 'failed'),
  ]);
  logger.info('Cleaned stale queue jobs to free Redis memory');

  await registerSchedules(discoveryQueue, syncQueue, crawlQueue);

  // Stagger fanout to avoid boot-time spike
  setTimeout(() => fanoutDiscovery(discoveryQueue).catch(e => logger.error({ err: e.message }, 'Discovery fanout error')), 30000);
  setTimeout(() => fanoutSync(syncQueue).catch(e => logger.error({ err: e.message }, 'Sync fanout error')), 60000);
  setTimeout(() => fanoutCrawl(crawlQueue).catch(e => logger.error({ err: e.message }, 'Crawl fanout error')), 90000);

  logger.info('Worker started — processing discovery, sync, and crawl queues');

  // Backfill descriptions for all ATS platforms every 10 minutes (with overlap guard)
  let allBackfillRunning = false;
  async function runAllBackfill() {
    logger.info('Backfill timer fired');
    if (allBackfillRunning) { logger.warn('All-ATS backfill still running, skipping'); return; }
    allBackfillRunning = true;
    try {
      const filled = await backfillDescriptions();
      logger.info({ filled }, 'Backfill cycle complete');
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, 'Description backfill error');
    } finally {
      allBackfillRunning = false;
    }
    const jitter = Math.floor(Math.random() * 120000);
    setTimeout(runAllBackfill, 10 * 60 * 1000 + jitter);
  }
  logger.info('Scheduling backfill in 3 minutes');
  setTimeout(runAllBackfill, 3 * 60 * 1000);

  // Backfill classifications (visa, remote, experience) every 5 minutes
  async function runClassificationBackfill() {
    try {
      await backfillClassifications();
    } catch (err) {
      logger.error({ err: err.message }, 'Classification backfill error');
    }
    setTimeout(runClassificationBackfill, 5 * 60 * 1000);
  }
  setTimeout(runClassificationBackfill, 2 * 60 * 1000); // Start 2 minutes after boot

  async function shutdown(signal) {
    logger.info({ signal }, 'Shutting down worker');
    // Force exit after 20s to stay within Heroku's 30s SIGTERM window
    const forceTimer = setTimeout(() => {
      logger.warn('Forcing exit after 20s shutdown timeout');
      process.exit(1);
    }, 20000);
    forceTimer.unref();
    try {
      await Promise.allSettled([
        crawlWorker.close(),
        discoveryWorker.close(),
        syncWorker.close(),
      ]);
      await Promise.allSettled([
        crawlQueue.close(),
        discoveryQueue.close(),
        syncQueue.close(),
      ]);
      await closeDb();
    } catch (err) {
      logger.error({ err: err.message }, 'Error during shutdown');
    }
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
