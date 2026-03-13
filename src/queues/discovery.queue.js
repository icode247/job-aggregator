const { Queue, Worker } = require('bullmq');
const { createRedisConnection } = require('./connection');
const { fetchUnlockedHtml } = require('../adapters/brightdata');
const { extractAtsSlug } = require('../adapters/extractor');
const { companiesRepo } = require('../db');
const logger = require('../logger');
const config = require('../config');

const QUEUE_NAME = 'discovery';

function createDiscoveryQueue() {
  return new Queue(QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  });
}

function createDiscoveryWorker(syncQueue) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      // Fan-out jobs are handled by the worker 'completed' event in worker.js
      if (job.data.fanout) return { status: 'fanout' };

      const { companyId, careerUrl, domain } = job.data;
      logger.info({ companyId, careerUrl }, 'Discovery job started');

      // Try Bright Data HTML scan first, then fall back to direct API probing
      let html = '';
      try {
        html = await fetchUnlockedHtml(careerUrl);
      } catch (err) {
        logger.warn({ companyId, err: err.message }, 'Bright Data fetch failed, falling back to API probe');
      }

      const result = await extractAtsSlug(html, domain);

      if (!result) {
        companiesRepo.markUnsupported(companyId);
        logger.warn({ companyId, careerUrl }, 'No supported ATS found');
        return { status: 'unsupported' };
      }

      companiesRepo.updateDiscovery(companyId, {
        ats: result.ats,
        atsSlug: result.clientname,
      });

      // Enqueue a sync job for this newly discovered company
      await syncQueue.add(`sync-${companyId}`, {
        companyId,
        ats: result.ats,
        atsSlug: result.clientname,
      });

      logger.info({ companyId, ats: result.ats, slug: result.clientname }, 'Discovery complete');
      return { status: 'discovered', ats: result.ats, slug: result.clientname };
    },
    {
      connection: createRedisConnection(),
      limiter: config.DISCOVERY_RATE_LIMIT,
      concurrency: 2,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, companyId: job?.data?.companyId, err: err.message }, 'Discovery job failed');
    if (job?.data?.companyId && job.attemptsMade >= job.opts.attempts) {
      companiesRepo.markFailed(job.data.companyId, err.message);
    }
  });

  return worker;
}

module.exports = { createDiscoveryQueue, createDiscoveryWorker };
