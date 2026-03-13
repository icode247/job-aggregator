const { Queue, Worker } = require('bullmq');
const { createRedisConnection } = require('./connection');
const { crawlGoogle, crawlDictionary, crawlSitemaps } = require('../crawlers');
const { companiesRepo, crawlSourcesRepo } = require('../db');
const logger = require('../logger');
const config = require('../config');

const QUEUE_NAME = 'crawl';

function createCrawlQueue() {
  return new Queue(QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 120000 },
      removeOnComplete: 50,
      removeOnFail: 100,
    },
  });
}

/**
 * Process discovered slugs: deduplicate, create companies, enqueue sync jobs.
 */
async function processDiscoveredSlugs(slugs, source, crawlRun, syncQueue) {
  let newCompanies = 0;
  let duplicates = 0;

  for (const { ats, slug } of slugs) {
    // Dedup against crawl_sources
    const isNew = crawlSourcesRepo.insertIfNew(ats, slug, source, crawlRun);
    if (!isNew) {
      duplicates++;
      continue;
    }

    // Dedup against existing companies
    const existing = companiesRepo.findByAtsAndSlug(ats, slug);
    if (existing) {
      duplicates++;
      continue;
    }

    // Create new company
    const company = companiesRepo.createFromCrawl({ ats, atsSlug: slug, origin: 'crawl' });
    if (company) {
      newCompanies++;
      // Enqueue sync job to fetch actual jobs
      await syncQueue.add(`sync-${company.id}`, {
        companyId: company.id,
        ats: company.ats,
        atsSlug: company.ats_slug,
      });
    }
  }

  logger.info({ source, newCompanies, duplicates, total: slugs.length }, 'Crawl results processed');
  return { newCompanies, duplicates };
}

function createCrawlWorker(syncQueue) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.data.fanout) return { status: 'fanout' };

      const { strategy, crawlRun } = job.data;
      const run = crawlRun || new Date().toISOString();

      logger.info({ strategy, crawlRun: run }, 'Crawl job started');

      let slugs = [];

      switch (strategy) {
        case 'google': {
          const ats = job.data.ats || 'greenhouse';
          slugs = await crawlGoogle(ats, config.CRAWL_GOOGLE_MAX_PAGES);
          break;
        }
        case 'google-all': {
          // Crawl Google for all ATS platforms
          for (const ats of ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee']) {
            const results = await crawlGoogle(ats, config.CRAWL_GOOGLE_MAX_PAGES);
            slugs.push(...results);
            // Pause between ATS platforms
            await new Promise(r => setTimeout(r, 5000));
          }
          break;
        }
        case 'dictionary': {
          slugs = await crawlDictionary();
          break;
        }
        case 'sitemap': {
          slugs = await crawlSitemaps();
          break;
        }
        default:
          throw new Error(`Unknown crawl strategy: ${strategy}`);
      }

      const result = await processDiscoveredSlugs(slugs, strategy, run, syncQueue);
      logger.info({ strategy, ...result }, 'Crawl job complete');
      return result;
    },
    {
      connection: createRedisConnection(),
      limiter: config.CRAWL_RATE_LIMIT,
      concurrency: 1,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, strategy: job?.data?.strategy, err: err.message }, 'Crawl job failed');
  });

  return worker;
}

module.exports = { createCrawlQueue, createCrawlWorker };
