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
  smartrecruiters: (slug) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings`,
  rippling: (slug) => `https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`,
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
        // SmartRecruiters returns 200 with empty content for invalid slugs
        if (ats === 'smartrecruiters') {
          const data = await res.json();
          if (!data.totalFound || data.totalFound === 0) return;
        }
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
 * Load company names from all dictionary files in the data directory.
 */
function loadAllNames() {
  const dataDir = path.join(__dirname, '..', '..', 'data');
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.txt'));
  const allNames = new Set();

  for (const file of files) {
    const content = fs.readFileSync(path.join(dataDir, file), 'utf-8');
    const names = content.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
    for (const name of names) allNames.add(name);
  }

  return [...allNames];
}

/**
 * Process a batch of names concurrently.
 */
async function probeBatch(names) {
  const results = [];
  const promises = names.map(async (name) => {
    const slugs = nameToSlugs(name);
    for (const slug of slugs) {
      const hits = await probeSlug(slug);
      if (hits.length > 0) {
        logger.info({ name, slug, hits: hits.map(h => h.ats) }, 'Dictionary hit');
        results.push(...hits);
        break;
      }
    }
  });
  await Promise.allSettled(promises);
  return results;
}

/**
 * Crawl using a dictionary of company names.
 * Probes all ATS APIs in parallel for each name.
 * @param {Function} onHits - optional callback(hits[]) called after each batch with new hits
 */
async function crawlDictionary(onHits) {
  const names = loadAllNames();

  if (names.length === 0) {
    logger.warn('No dictionary files found or all empty');
    return [];
  }

  logger.info({ count: names.length }, 'Starting dictionary crawl');

  const allResults = [];
  const batchSize = 15; // 15 names concurrently, each probing 7 ATS = 105 requests

  for (let i = 0; i < names.length; i += batchSize) {
    const batch = names.slice(i, i + batchSize);
    const hits = await probeBatch(batch);
    allResults.push(...hits);

    // Process hits incrementally so new companies appear immediately
    if (hits.length > 0 && onHits) {
      try { await onHits(hits); } catch (err) {
        logger.error({ err: err.message }, 'Failed to process dictionary hits');
      }
    }

    // Rate limit: pause between batches
    if (i % 150 === 0 && i > 0) {
      logger.info({ progress: `${i}/${names.length}`, hits: allResults.length }, 'Dictionary crawl progress');
    }
    await new Promise(r => setTimeout(r, 500));
  }

  logger.info({ totalHits: allResults.length, totalProbed: names.length }, 'Dictionary crawl complete');
  return allResults;
}

module.exports = { crawlDictionary, nameToSlugs, probeSlug };
