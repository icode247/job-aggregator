const { companiesRepo } = require('../db');
const logger = require('../logger');
const config = require('../config');

async function registerSchedules(syncQueue) {
  await syncQueue.add('sync-fanout', { fanout: true }, {
    repeat: { every: config.SYNC_INTERVAL_MS },
    jobId: 'sync-fanout',
  });

  logger.info('Repeatable schedules registered (sync only)');
}

async function fanoutSync(syncQueue) {
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

module.exports = { registerSchedules, fanoutSync };
