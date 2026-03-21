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
      removeOnComplete: 3,
      removeOnFail: 5,
    },
  });
}

function createDiscoveryWorker(syncQueue) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.data.fanout) return { status: 'fanout' };

      const { companyId, careerUrl, domain } = job.data;
      logger.info({ companyId, careerUrl }, 'Discovery job started');

      let html = '';
      try {
        html = await fetchUnlockedHtml(careerUrl);
      } catch (err) {
        logger.warn({ companyId, err: err.message }, 'Proxy fetch failed, falling back to API probe');
      }

      const result = await extractAtsSlug(html, domain);

      if (!result) {
        await companiesRepo.markUnsupported(companyId);
        logger.warn({ companyId, careerUrl }, 'No supported ATS found');
        return { status: 'unsupported' };
      }

      await companiesRepo.updateDiscovery(companyId, {
        ats: result.ats,
        atsSlug: result.clientname,
      });

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
      concurrency: 20,
    }
  );

  worker.on('failed', async (job, err) => {
    logger.error({ jobId: job?.id, companyId: job?.data?.companyId, err: err.message }, 'Discovery job failed');
    if (job?.data?.companyId && job.attemptsMade >= job.opts.attempts) {
      await companiesRepo.markFailed(job.data.companyId, err.message);
    }
  });

  return worker;
}

module.exports = { createDiscoveryQueue, createDiscoveryWorker };
