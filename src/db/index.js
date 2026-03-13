const companiesRepo = require('./repositories/companies');
const jobsRepo = require('./repositories/jobs');
const crawlSourcesRepo = require('./repositories/crawl-sources');
const { migrate } = require('./schema');
const { closeDb } = require('./connection');

module.exports = { companiesRepo, jobsRepo, crawlSourcesRepo, migrate, closeDb };
