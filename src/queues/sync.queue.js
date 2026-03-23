const { Queue, Worker } = require('bullmq');
const { createRedisConnection } = require('./connection');
const { getAdapter } = require('../adapters');
const { fetchLogoUrl } = require('../adapters/logo');
const { companiesRepo, jobsRepo } = require('../db');
const logger = require('../logger');
const config = require('../config');
const { extractSalary, extractWorkplaceType, extractEmploymentType } = require('../utils/extract');
const { stripHtml } = require('../utils/html');
const metrics = require('../utils/metrics');
const { classifyJob } = require('../utils/classify');

const QUEUE_NAME = 'sync';

// Per-ATS concurrency limits for platforms with aggressive rate limiting
const ATS_MAX_CONCURRENT = { workable: 1, recruitee: 3, workday: 2 };
// Per-ATS delay (ms) between consecutive jobs to avoid rate limits
const ATS_POST_DELAY = { workable: 5000 };
const atsConcurrency = {};

function acquireAtsSlot(ats) {
  if (!ATS_MAX_CONCURRENT[ats]) return true;
  atsConcurrency[ats] = atsConcurrency[ats] || 0;
  if (atsConcurrency[ats] >= ATS_MAX_CONCURRENT[ats]) return false;
  atsConcurrency[ats]++;
  return true;
}

function releaseAtsSlot(ats) {
  if (!ATS_MAX_CONCURRENT[ats]) return;
  atsConcurrency[ats] = Math.max(0, (atsConcurrency[ats] || 0) - 1);
}

function waitForAtsSlot(ats, interval = 500) {
  if (!ATS_MAX_CONCURRENT[ats]) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (acquireAtsSlot(ats)) return resolve();
      setTimeout(check, interval);
    };
    check();
  });
}

function createSyncQueue() {
  return new Queue(QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 60000 },
      removeOnComplete: 3,
      removeOnFail: 5,
    },
  });
}

function createSyncWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.data.fanout) return { status: 'fanout' };

      const { companyId, ats, atsSlug } = job.data;

      // Wait for a slot if this ATS has a concurrency cap
      await waitForAtsSlot(ats);

      logger.info({ companyId, ats, atsSlug }, 'Sync job started');

      const adapter = getAdapter(ats);
      try {
        const result = await adapter.fetchJobs(atsSlug);

        const incomingJobs = result.jobs || result;
        const meta = result.meta || {};

        const company = await companiesRepo.findById(companyId);
        const domain = company?.domain;

        if (ats === 'greenhouse' && adapter.fetchCompanyMeta) {
          const ghMeta = await adapter.fetchCompanyMeta(atsSlug);
          if (ghMeta) {
            meta.companyName = meta.companyName || ghMeta.companyName;
          }
        }

        if (!meta.companyName && atsSlug) {
          meta.companyName = atsSlug.charAt(0).toUpperCase() + atsSlug.slice(1);
        }

        const needsLogoRefresh = !company?.logo_url
          || company.logo_url.includes('clearbit.com')
          || (company.logo_url.includes('gstatic.com/faviconV2') && (
            company.logo_url.includes('icims.com') || company.logo_url.includes('oraclecloud')
            || company.logo_url.includes('taleo.net') || company.logo_url.includes('successfactors')
            || company.logo_url.includes('.CX') || company.logo_url.includes('saasfaprod')
            || company.logo_url.includes('careers-')
          ));
        if (needsLogoRefresh) {
          // Use logo from adapter meta first, fall back to scraping career page
          if (!meta.logoUrl) {
            meta.logoUrl = await fetchLogoUrl(ats, atsSlug, domain);
          }
        }

        await companiesRepo.updateMeta(companyId, meta);

        for (const job of incomingJobs) {
          const plainDesc = job.description ? stripHtml(job.description) : null;
          if (!job.salary_min && plainDesc) {
            const salary = extractSalary(plainDesc);
            if (salary) {
              job.salary_min = salary.min;
              job.salary_max = salary.max;
              job.salary_currency = salary.currency;
              job.salary_interval = salary.interval;
            }
          }
          if (!job.workplace_type) {
            job.workplace_type = extractWorkplaceType(job.title, job.location, plainDesc);
          }
          if (!job.employment_type) {
            job.employment_type = extractEmploymentType(job.title, plainDesc);
          }

          // Classify: remote, worldwide, visa, experience level
          const tags = classifyJob(job);
          job.is_remote = tags.is_remote;
          job.remote_worldwide = tags.remote_worldwide;
          job.visa_sponsorship = tags.visa_sponsorship;
          job.experience_level = tags.experience_level;
        }

        const diff = await jobsRepo.syncForCompany(companyId, ats, incomingJobs);
        await companiesRepo.updateLastSynced(companyId);

        metrics.increment(`sync.success.${ats}`);
        metrics.increment('sync.jobs_added', diff.added);
        metrics.increment('sync.jobs_removed', diff.removed);

        logger.info({ companyId, ats, ...diff }, 'Sync job complete');
        return diff;
      } finally {
        releaseAtsSlot(ats);
        // Delay between consecutive jobs for rate-limited ATS platforms
        if (ATS_POST_DELAY[ats]) {
          await new Promise(r => setTimeout(r, ATS_POST_DELAY[ats]));
        }
      }
    },
    {
      connection: createRedisConnection(),
      limiter: config.SYNC_RATE_LIMIT,
      concurrency: 20,
    }
  );

  worker.on('failed', async (job, err) => {
    metrics.increment(`sync.failure.${job?.data?.ats || 'unknown'}`);
    logger.error({ jobId: job?.id, companyId: job?.data?.companyId, err: err.message }, 'Sync job failed');
    if (job?.data?.companyId && job.attemptsMade >= job.opts.attempts) {
      // Don't permanently fail companies for rate limiting — they'll succeed next cycle
      if (err.message.includes('429')) return;
      await companiesRepo.markFailed(job.data.companyId, err.message);
    }
  });

  return worker;
}

module.exports = { createSyncQueue, createSyncWorker };
