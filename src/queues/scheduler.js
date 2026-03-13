const { companiesRepo } = require('../db');
const logger = require('../logger');
const config = require('../config');

/**
 * Registers repeatable fan-out jobs.
 * Called once on worker startup.
 */
async function registerSchedules(discoveryQueue, syncQueue, crawlQueue) {
  // Fan-out discovery: runs every 7 days
  await discoveryQueue.add(
    'discovery-fanout',
    { fanout: true },
    {
      repeat: { every: config.DISCOVERY_INTERVAL_MS },
      jobId: 'discovery-fanout',
    }
  );

  // Fan-out sync: runs every 2 hours
  await syncQueue.add(
    'sync-fanout',
    { fanout: true },
    {
      repeat: { every: config.SYNC_INTERVAL_MS },
      jobId: 'sync-fanout',
    }
  );

  // Fan-out crawl: runs every 30 days
  await crawlQueue.add(
    'crawl-fanout',
    { fanout: true },
    {
      repeat: { every: config.CRAWL_INTERVAL_MS },
      jobId: 'crawl-fanout',
    }
  );

  logger.info('Repeatable schedules registered');
}

/**
 * Enqueue individual discovery jobs for all companies.
 */
async function fanoutDiscovery(discoveryQueue) {
  const companies = companiesRepo.findAll();
  logger.info({ count: companies.length }, 'Fanning out discovery jobs');

  for (const company of companies) {
    await discoveryQueue.add(`discover-${company.id}`, {
      companyId: company.id,
      careerUrl: company.career_url,
      domain: company.domain,
    });
  }
}

/**
 * Enqueue individual sync jobs for all active companies.
 */
async function fanoutSync(syncQueue) {
  const companies = companiesRepo.findActive();
  logger.info({ count: companies.length }, 'Fanning out sync jobs');

  for (const company of companies) {
    await syncQueue.add(`sync-${company.id}`, {
      companyId: company.id,
      ats: company.ats,
      atsSlug: company.ats_slug,
    });
  }
}

/**
 * Enqueue crawl jobs for all strategies.
 */
async function fanoutCrawl(crawlQueue) {
  const crawlRun = new Date().toISOString();
  logger.info({ crawlRun }, 'Fanning out crawl jobs');

  await crawlQueue.add('crawl-sitemap', { strategy: 'sitemap', crawlRun });
  await crawlQueue.add('crawl-dictionary', { strategy: 'dictionary', crawlRun });
  await crawlQueue.add('crawl-google-all', { strategy: 'google-all', crawlRun });
}

module.exports = { registerSchedules, fanoutDiscovery, fanoutSync, fanoutCrawl };
