const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');

const ATS_PROBE_URLS = {
  greenhouse: (slug) => `https://api.greenhouse.io/v1/boards/${slug}/jobs`,
  ashby: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
  lever: (slug) => `https://api.lever.co/v0/postings/${slug}`,
  workable: (slug) => `https://apply.workable.com/api/v1/widget/accounts/${slug}`,
  recruitee: (slug) => `https://${slug}.recruitee.com/api/offers`,
};

/**
 * Convert a company name to candidate slugs.
 * e.g., "Exploding Kittens Inc." -> ["exploding-kittens", "explodingkittens"]
 */
function nameToSlugs(name) {
  const cleaned = name
    .toLowerCase()
    .replace(/[,.&]/g, '')
    .replace(/\b(inc|llc|ltd|corp|co|gmbh|sa|plc)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const hyphenated = cleaned.replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const joined = cleaned.replace(/\s+/g, '');

  const slugs = new Set([hyphenated, joined]);

  // Also try just the first word for single-brand companies
  const firstWord = cleaned.split(/\s+/)[0];
  if (firstWord.length > 2) slugs.add(firstWord);

  return [...slugs].filter(s => s.length > 1);
}

/**
 * Probe all ATS APIs for a single slug. Returns array of { ats, slug } for hits.
 */
async function probeSlug(slug) {
  const results = [];
  const probes = Object.entries(ATS_PROBE_URLS).map(async ([ats, urlFn]) => {
    try {
      const res = await fetch(urlFn(slug), { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        results.push({ ats, slug });
      }
    } catch {
      // timeout or network error — skip
    }
  });

  await Promise.allSettled(probes);
  return results;
}

/**
 * Crawl using a dictionary of company names.
 * Probes all ATS APIs in parallel for each name.
 */
async function crawlDictionary() {
  const dictPath = config.CRAWL_DICTIONARY_PATH;

  if (!fs.existsSync(dictPath)) {
    logger.warn({ path: dictPath }, 'Dictionary file not found');
    return [];
  }

  const names = fs.readFileSync(dictPath, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  logger.info({ count: names.length }, 'Starting dictionary crawl');

  const allResults = [];

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const slugs = nameToSlugs(name);

    for (const slug of slugs) {
      const hits = await probeSlug(slug);
      if (hits.length > 0) {
        logger.info({ name, slug, hits: hits.map(h => h.ats) }, 'Dictionary hit');
        allResults.push(...hits);
        break; // Found a hit for this name, skip remaining slug variants
      }
    }

    // Rate limit: small delay between names
    if (i % 10 === 9) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  logger.info({ totalHits: allResults.length }, 'Dictionary crawl complete');
  return allResults;
}

module.exports = { crawlDictionary, nameToSlugs, probeSlug };
