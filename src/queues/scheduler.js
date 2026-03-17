const { companiesRepo } = require('../db');
const logger = require('../logger');
const config = require('../config');

async function registerSchedules(discoveryQueue, syncQueue, crawlQueue) {
  await discoveryQueue.add('discovery-fanout', { fanout: true }, {
    repeat: { every: config.DISCOVERY_INTERVAL_MS },
    jobId: 'discovery-fanout',
  });

  await syncQueue.add('sync-fanout', { fanout: true }, {
    repeat: { every: config.SYNC_INTERVAL_MS },
    jobId: 'sync-fanout',
  });

  await crawlQueue.add('crawl-fanout', { fanout: true }, {
    repeat: { every: config.CRAWL_INTERVAL_MS },
    jobId: 'crawl-fanout',
  });

  logger.info('Repeatable schedules registered');
}

async function fanoutDiscovery(discoveryQueue) {
  const companies = await companiesRepo.findPending();
  logger.info({ count: companies.length }, 'Fanning out discovery jobs');
  for (const company of companies) {
    await discoveryQueue.add(`discover-${company.id}`, {
      companyId: company.id,
      careerUrl: company.career_url,
      domain: company.domain,
    });
  }
}

async function fanoutSync(syncQueue) {
  // Prioritize: never-synced first, then oldest-synced
  const companies = await companiesRepo.findDueForSync();
  logger.info({ count: companies.length }, 'Fanning out sync jobs');
  for (const company of companies) {
    await syncQueue.add(`sync-${company.id}`, {
      companyId: company.id,
      ats: company.ats,
      atsSlug: company.ats_slug,
    }, { jobId: `sync-${company.id}` });
  }
}

async function fanoutCrawl(crawlQueue) {
  const crawlRun = new Date().toISOString();
  logger.info({ crawlRun }, 'Fanning out crawl jobs');
  await crawlQueue.add('crawl-sitemap', { strategy: 'sitemap', crawlRun });
  await crawlQueue.add('crawl-dictionary', { strategy: 'dictionary', crawlRun });
  await crawlQueue.add('crawl-google-all', { strategy: 'google-all', crawlRun });
}

module.exports = { registerSchedules, fanoutDiscovery, fanoutSync, fanoutCrawl };
