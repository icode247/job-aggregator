/**
 * Backfill missing job descriptions across all ATS platforms.
 * Fetches individual job details for jobs with NULL descriptions.
 * Runs independently from the sync queue to avoid blocking.
 * Processes each ATS separately with per-ATS rate limits.
 */
const { query } = require('../db/connection');
const { discoverConfig } = require('../adapters/workday');
const logger = require('../logger');

const ATS_CONFIG = {
  workday:         { batchSize: 50, delayMs: 2000 },
  smartrecruiters: { batchSize: 50, delayMs: 500 },
  bamboohr:        { batchSize: 50, delayMs: 500 },
  jazzhr:          { batchSize: 50, delayMs: 500 },
  breezy:          { batchSize: 50, delayMs: 500 },
};

// Cache workday configs per slug
const wdConfigCache = new Map();

/**
 * Workday has multiple site slugs per company (e.g. VCA has Careers, BFCareers, etc.)
 * Try all known site slugs if the first one fails with 422.
 */
async function discoverAllSiteSlugs(slug) {
  for (const wd of [1, 2, 3, 5, 12]) {
    try {
      const res = await fetch(`https://${slug}.wd${wd}.myworkdayjobs.com/robots.txt`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const text = await res.text();
      const matches = [...text.matchAll(/myworkdayjobs\.com\/([^/\s]+)/g)];
      if (matches.length > 0) {
        return { wdNum: wd, siteSlugs: matches.map(m => m[1]) };
      }
    } catch { /* try next */ }
  }
  return null;
}

async function fetchWorkdayDescription(job, rawData) {
  const cacheKey = job.ats_slug;
  if (!wdConfigCache.has(cacheKey)) {
    const config = await discoverAllSiteSlugs(job.ats_slug);
    wdConfigCache.set(cacheKey, config);
  }
  const config = wdConfigCache.get(cacheKey);
  if (!config) return null;

  const { wdNum, siteSlugs } = config;
  const externalPath = rawData?.externalPath;
  if (!externalPath) return null;

  // Try each site slug until one works
  for (const siteSlug of siteSlugs) {
    try {
      const url = `https://${job.ats_slug}.wd${wdNum}.myworkdayjobs.com/wday/cxs/${job.ats_slug}/${siteSlug}${externalPath}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (res.status === 403) return null; // Rate limited — stop trying
      if (!res.ok) continue; // 422 = wrong siteSlug, try next
      const detail = await res.json();
      const desc = detail?.jobPostingInfo?.jobDescription;
      if (desc) return desc;
    } catch { /* timeout — try next */ }
  }
  return null;
}

async function fetchSmartRecruitersDescription(job) {
  const postingId = job.external_id.replace('smartrecruiters_', '');
  const res = await fetch(
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(job.ats_slug)}/postings/${postingId}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const detail = await res.json();
  if (!detail?.jobAd?.sections) return null;
  const parts = [];
  for (const section of Object.values(detail.jobAd.sections)) {
    if (section.text) parts.push(section.text);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

async function fetchBambooHRDescription(job) {
  const jobId = job.external_id.replace('bamboohr_', '');
  const res = await fetch(
    `https://${job.ats_slug}.bamboohr.com/careers/${jobId}/detail`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data?.result?.jobOpening?.description || null;
}

function extractJsonLdDescription(html) {
  const ldRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch;
  while ((ldMatch = ldRegex.exec(html)) !== null) {
    try {
      const ld = JSON.parse(ldMatch[1]);
      if (ld['@type'] === 'JobPosting' && ld.description) {
        return ld.description;
      }
    } catch { /* invalid JSON-LD */ }
  }
  return null;
}

async function fetchJazzHRDescription(job) {
  if (!job.url) return null;
  const res = await fetch(job.url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const html = await res.text();
  // Try JSON-LD first
  const ld = extractJsonLdDescription(html);
  if (ld) return ld;
  // JazzHR embeds description in the largest content div
  const divs = html.match(/<div[^>]*>((?:(?!<div).)*?)<\/div>/gs) || [];
  let best = null;
  let bestLen = 0;
  for (const div of divs) {
    const clean = div.replace(/<[^>]+>/g, '').trim();
    if (clean.length > bestLen && clean.length > 100) {
      bestLen = clean.length;
      best = div.replace(/^<div[^>]*>/, '').replace(/<\/div>$/, '').trim();
    }
  }
  return best;
}

async function fetchBreezyDescription(job) {
  if (!job.url) return null;
  const res = await fetch(job.url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const html = await res.text();
  // Try JSON-LD first
  const ld = extractJsonLdDescription(html);
  if (ld) return ld;
  // Breezy has description in og:description meta tag
  const ogMatch = html.match(/property="og:description"[^>]*content="([^"]*)"/i);
  if (ogMatch?.[1] && ogMatch[1].length > 50) return ogMatch[1];
  return null;
}

async function fetchDescription(job) {
  const rawData = typeof job.raw_data === 'string' ? JSON.parse(job.raw_data) : job.raw_data;

  switch (job.ats) {
    case 'workday':
      return fetchWorkdayDescription(job, rawData);
    case 'smartrecruiters':
      return fetchSmartRecruitersDescription(job);
    case 'bamboohr':
      return fetchBambooHRDescription(job);
    case 'jazzhr':
      return fetchJazzHRDescription(job);
    case 'breezy':
      return fetchBreezyDescription(job);
    default:
      return null;
  }
}

async function backfillForAts(ats, batchSize, delayMs) {
  const { rows: jobs } = await query(
    `SELECT j.id, j.ats, j.external_id, j.url, j.raw_data, c.ats_slug
     FROM jobs j JOIN companies c ON j.company_id = c.id
     WHERE j.removed_at IS NULL
     AND (j.description IS NULL OR j.description = '')
     AND j.ats = ?
     ORDER BY j.first_seen_at DESC
     LIMIT ?`,
    [ats, batchSize]
  );

  if (jobs.length === 0) return { filled: 0, failed: 0 };

  let filled = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      const description = await fetchDescription(job);
      if (description) {
        await query('UPDATE jobs SET description = ? WHERE id = ?', [description, job.id]);
        filled++;
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
      logger.warn({ jobId: job.id, ats: job.ats, slug: job.ats_slug, err: err.message }, 'Backfill fetch failed');
    }

    await new Promise(r => setTimeout(r, delayMs));
  }

  return { filled, failed };
}

async function backfillDescriptions() {
  logger.info('Description backfill: starting');

  let totalFilled = 0;
  let totalFailed = 0;

  for (const [ats, config] of Object.entries(ATS_CONFIG)) {
    const { filled, failed } = await backfillForAts(ats, config.batchSize, config.delayMs);
    if (filled > 0 || failed > 0) {
      logger.info({ ats, filled, failed }, 'Description backfill: ATS batch done');
    }
    totalFilled += filled;
    totalFailed += failed;
  }

  logger.info({ filled: totalFilled, failed: totalFailed }, 'Description backfill: complete');
  return totalFilled;
}

module.exports = { backfillDescriptions };
