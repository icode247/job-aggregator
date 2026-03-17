/**
 * Backfill missing job descriptions across all ATS platforms.
 * Fetches individual job details for jobs with NULL descriptions.
 * Runs independently from the sync queue to avoid blocking.
 */
const { query } = require('../db/connection');
const { discoverConfig } = require('../adapters/workday');
const logger = require('../logger');

const BATCH_SIZE = 200;
const DELAY_MS = 500;

// Cache workday configs to avoid re-discovering per job
const wdConfigCache = new Map();

async function fetchWorkdayDescription(job, rawData) {
  if (!wdConfigCache.has(job.ats_slug)) {
    const config = await discoverConfig(job.ats_slug);
    wdConfigCache.set(job.ats_slug, config);
  }
  const config = wdConfigCache.get(job.ats_slug);
  if (!config) return null;
  const { wdNum, siteSlug } = config;
  const baseUrl = `https://${job.ats_slug}.wd${wdNum}.myworkdayjobs.com/wday/cxs/${job.ats_slug}/${siteSlug}`;
  const externalPath = rawData?.externalPath;
  if (!externalPath) return null;
  const res = await fetch(`${baseUrl}${externalPath}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const detail = await res.json();
  return detail?.jobPostingInfo?.jobDescription || null;
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

async function fetchHtmlDescription(job) {
  if (!job.url) return null;
  const res = await fetch(job.url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const html = await res.text();
  return extractJsonLdDescription(html);
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
    case 'breezy':
      return fetchHtmlDescription(job);
    default:
      return null;
  }
}

async function backfillDescriptions() {
  const supported = ['workday', 'smartrecruiters', 'bamboohr', 'jazzhr', 'breezy'];
  const placeholders = supported.map(() => '?').join(',');

  const { rows: jobs } = await query(
    `SELECT j.id, j.ats, j.external_id, j.url, j.raw_data, c.ats_slug
     FROM jobs j JOIN companies c ON j.company_id = c.id
     WHERE j.removed_at IS NULL
     AND (j.description IS NULL OR j.description = '')
     AND j.ats IN (${placeholders})
     ORDER BY j.first_seen_at DESC
     LIMIT ${BATCH_SIZE}`,
    supported
  );

  if (jobs.length === 0) {
    logger.info('Description backfill: no jobs need descriptions');
    return 0;
  }

  logger.info({ count: jobs.length }, 'Description backfill: starting');

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
      logger.warn({ jobId: job.id, ats: job.ats, err: err.message }, 'Backfill detail fetch failed');
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  logger.info({ filled, failed, total: jobs.length }, 'Description backfill: complete');
  return filled;
}

module.exports = { backfillDescriptions };
