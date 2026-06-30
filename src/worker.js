const logger = require('./logger');
const { migrate, closeDb } = require('./db');
const metrics = require('./utils/metrics');
const { createRedisConnection } = require('./queues/connection');
const { createSyncQueue, createSyncWorker } = require('./queues/sync.queue');
const { registerSchedules, fanoutSync } = require('./queues/scheduler');
const { backfillDescriptions } = require('./tasks/backfill-descriptions');
const { backfillClassifications } = require('./tasks/backfill-classifications');
const { crawlWorkableMarketplace } = require('./tasks/crawl-workable-marketplace');
const { pruneDeadJobs } = require('./tasks/dead-job-check');

async function main() {
  await migrate();
  metrics.setRedis(createRedisConnection());

  const syncQueue = createSyncQueue();
  const syncWorker = createSyncWorker();

  syncWorker.on('completed', async (job) => {
    if (job.data.fanout) await fanoutSync(syncQueue);
  });

  // Clean stale jobs to free Redis memory
  await Promise.allSettled([
    syncQueue.drain().catch(() => {}),
    syncQueue.clean(0, 1000, 'completed'),
    syncQueue.clean(0, 1000, 'failed'),
  ]);
  logger.info('Cleaned stale queue jobs to free Redis memory');

  await registerSchedules(syncQueue);

  // Stagger sync fanout to avoid boot-time spike
  setTimeout(() => fanoutSync(syncQueue).catch(e => logger.error({ err: e.message }, 'Sync fanout error')), 30000);

  logger.info('Worker started — processing sync queue only (no discovery/crawl)');

  // Description backfill — re-enabled after fixing the four broken fetchers
  // (zoho parser, lever multi-field, smartrecruiters/workday SKIP-on-empty).
  // The 450-job backlog of unfetchable rows was cleared and marked N/A locally,
  // so the loop now only processes genuinely-new missing-description rows.
  let allBackfillRunning = false;
  async function runAllBackfill() {
    if (allBackfillRunning) { logger.warn('Description backfill still running, skipping'); return; }
    allBackfillRunning = true;
    try {
      const filled = await backfillDescriptions();
      logger.info({ filled }, 'Description backfill cycle complete');
    } catch (err) {
      logger.error({ err: err.message }, 'Description backfill error');
    } finally {
      allBackfillRunning = false;
    }
    setTimeout(runAllBackfill, 5 * 60 * 1000);
  }
  setTimeout(runAllBackfill, 5 * 60 * 1000);

  // Backfill classifications (visa, remote, experience) every 5 minutes
  async function runClassificationBackfill() {
    try {
      await backfillClassifications();
    } catch (err) {
      logger.error({ err: err.message }, 'Classification backfill error');
    }
    setTimeout(runClassificationBackfill, 60 * 1000);
  }
  setTimeout(runClassificationBackfill, 2 * 60 * 1000);

  // Clean up stale jobs older than 90 days — runs every 6 hours. (Dead postings
  // younger than this are pruned by liveness checks in runDeadJobPruning below.)
  async function runStaleJobCleanup() {
    try {
      const { query } = require('./db/connection');
      const { rows } = await query("DELETE FROM jobs WHERE posted_at IS NOT NULL AND posted_at < NOW() - INTERVAL '90 days' RETURNING id");
      if (rows.length > 0) {
        logger.info({ deleted: rows.length }, 'Stale job cleanup: removed jobs older than 90 days');
      }
    } catch (err) {
      logger.error({ err: err.message }, 'Stale job cleanup error');
    }
    setTimeout(runStaleJobCleanup, 6 * 60 * 60 * 1000);
  }
  setTimeout(runStaleJobCleanup, 5 * 60 * 1000);

  // Dead-job pruning: verify a rotating batch of the older job tail (>30d) against
  // their career pages and remove confirmed-dead postings. Runs hourly so the 30–90d
  // window we now retain stays free of filled/expired listings. Only 404/410 or an
  // explicit dead-page phrase prunes a job; transient failures are re-checked later.
  async function runDeadJobPruning() {
    try {
      const { checked, dead, uncertain } = await pruneDeadJobs({ limit: 400, concurrency: 10, tailDays: 30, recheckDays: 14 });
      if (checked > 0) {
        logger.info({ checked, dead, uncertain }, 'Dead-job pruning: verified batch of older jobs');
      }
    } catch (err) {
      logger.error({ err: err.message }, 'Dead-job pruning error');
    }
    setTimeout(runDeadJobPruning, 60 * 60 * 1000);
  }
  setTimeout(runDeadJobPruning, 8 * 60 * 1000);

  // Workable marketplace crawl RE-ENABLED (2026-06-30). Pulls jobs.workable.com's
  // public marketplace API (jobs.workable.com/api/v1/jobs) — verified reachable from
  // Heroku (200, paginates), distinct from the apply.workable.com company feeds that
  // 403 under load. Self-contained loop (does NOT use the sync queue), ~10k latest
  // jobs/cycle, 1s/page delay, every 6h — keeps the ~53k /view/ marketplace jobs fresh.
  let workableMarketplaceRunning = false;
  async function runWorkableMarketplace() {
    if (workableMarketplaceRunning) { logger.warn('Workable marketplace crawl still running, skipping'); return; }
    workableMarketplaceRunning = true;
    try {
      const added = await crawlWorkableMarketplace();
      logger.info({ added }, 'Workable marketplace crawl cycle complete');
    } catch (err) {
      logger.error({ err: err.message }, 'Workable marketplace crawl error');
    } finally {
      workableMarketplaceRunning = false;
    }
    setTimeout(runWorkableMarketplace, 6 * 60 * 60 * 1000);
  }
  setTimeout(runWorkableMarketplace, 3 * 60 * 1000);
  logger.info('Workable marketplace crawl enabled (jobs.workable.com marketplace API)');

  async function shutdown(signal) {
    logger.info({ signal }, 'Shutting down worker');
    const forceTimer = setTimeout(() => {
      logger.warn('Forcing exit after 20s shutdown timeout');
      process.exit(1);
    }, 20000);
    forceTimer.unref();
    try {
      await Promise.allSettled([syncWorker.close()]);
      await Promise.allSettled([syncQueue.close()]);
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
