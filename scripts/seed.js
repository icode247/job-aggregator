const { migrate, companiesRepo } = require('../src/db');
const logger = require('../src/logger');

const SEED_URLS = [
  'https://www.anthropic.com/careers',
  'https://explodingkittens.com/jobs',
  'https://www.drata.com/careers',
];

function extractDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

migrate();

let added = 0;
for (const url of SEED_URLS) {
  const domain = extractDomain(url);
  const company = companiesRepo.create({ careerUrl: url, domain });
  if (company) {
    added++;
    logger.info({ id: company.id, domain, url }, 'Seeded company');
  }
}

logger.info({ added, total: SEED_URLS.length }, 'Seed complete');
process.exit(0);
