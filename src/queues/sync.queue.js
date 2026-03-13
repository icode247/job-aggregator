const { Queue, Worker } = require('bullmq');
const { createRedisConnection } = require('./connection');
const { getAdapter } = require('../adapters');
const { fetchLogoUrl } = require('../adapters/logo');
const { companiesRepo, jobsRepo } = require('../db');
const logger = require('../logger');
const config = require('../config');

const QUEUE_NAME = 'sync';

function createSyncQueue() {
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

function createSyncWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      // Fan-out jobs are handled by the worker 'completed' event in worker.js
      if (job.data.fanout) return { status: 'fanout' };

      const { companyId, ats, atsSlug } = job.data;
      logger.info({ companyId, ats, atsSlug }, 'Sync job started');

      const adapter = getAdapter(ats);
      const result = await adapter.fetchJobs(atsSlug);

      // Adapters now return { jobs, meta }
      const incomingJobs = result.jobs || result;
      const meta = result.meta || {};

      // Get the company's current data
      const company = companiesRepo.findById(companyId);
      const domain = company?.domain;

      // For Greenhouse, fetch company name from board endpoint
      if (ats === 'greenhouse' && adapter.fetchCompanyMeta) {
        const ghMeta = await adapter.fetchCompanyMeta(atsSlug);
        if (ghMeta) {
          meta.companyName = meta.companyName || ghMeta.companyName;
        }
      }

      // Derive company name from ATS slug if API doesn't provide it
      if (!meta.companyName && atsSlug) {
        meta.companyName = atsSlug.charAt(0).toUpperCase() + atsSlug.slice(1);
      }

      // Fetch real logo from the ATS hosted page (only if we don't have one yet)
      if (!company?.logo_url || company.logo_url.includes('clearbit.com')) {
        meta.logoUrl = await fetchLogoUrl(ats, atsSlug, domain);
      }

      companiesRepo.updateMeta(companyId, meta);

      const diff = jobsRepo.syncForCompany(companyId, ats, incomingJobs);
      companiesRepo.updateLastSynced(companyId);

      logger.info({ companyId, ats, ...diff }, 'Sync job complete');
      return diff;
    },
    {
      connection: createRedisConnection(),
      limiter: config.SYNC_RATE_LIMIT,
      concurrency: 3,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, companyId: job?.data?.companyId, err: err.message }, 'Sync job failed');
    if (job?.data?.companyId && job.attemptsMade >= job.opts.attempts) {
      companiesRepo.markFailed(job.data.companyId, err.message);
    }
  });

  return worker;
}

module.exports = { createSyncQueue, createSyncWorker };
