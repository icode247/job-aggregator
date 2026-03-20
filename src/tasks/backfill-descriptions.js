/**
 * Backfill missing job descriptions across all ATS platforms.
 * Fetches individual job details for jobs with NULL descriptions.
 * Runs independently from the sync queue to avoid blocking.
 * Processes each ATS separately with per-ATS rate limits.
 */
const { query } = require('../db/connection');
const { discoverConfig } = require('../adapters/workday');
const logger = require('../logger');
const metrics = require('../utils/metrics');

const ATS_CONFIG = {
  workday:         { batchSize: 50, delayMs: 2000 },
  taleo:           { batchSize: 20, delayMs: 500 },
  smartrecruiters: { batchSize: 50, delayMs: 500 },
  bamboohr:        { batchSize: 50, delayMs: 500 },
  jazzhr:          { batchSize: 50, delayMs: 500 },
  breezy:          { batchSize: 50, delayMs: 500 },
  oracle:          { batchSize: 30, delayMs: 300 },
  greenhouse:      { batchSize: 50, delayMs: 300 },
  lever:           { batchSize: 50, delayMs: 300 },
  ashby:           { batchSize: 50, delayMs: 300 },
  icims:           { batchSize: 30, delayMs: 500 },
  personio:        { batchSize: 50, delayMs: 500 },
  recruitee:       { batchSize: 50, delayMs: 300 },
  rippling:        { batchSize: 30, delayMs: 500 },
  zoho:            { batchSize: 20, delayMs: 800 },
  // workable:        { batchSize: 200, delayMs: 3000 }, // disabled — API unreliable
  jobvite:         { batchSize: 50, delayMs: 500 },
  pinpoint:        { batchSize: 50, delayMs: 300 },
  successfactors:  { batchSize: 30, delayMs: 1000 },
};

// Cache workday configs per slug with TTL (1 hour)
const wdConfigCache = new Map();
const WD_CACHE_TTL_MS = 60 * 60 * 1000;

function getWdConfig(key) {
  const entry = wdConfigCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > WD_CACHE_TTL_MS) {
    wdConfigCache.delete(key);
    return undefined;
  }
  return entry.config;
}

function setWdConfig(key, config) {
  wdConfigCache.set(key, { config, timestamp: Date.now() });
}

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
  let config = getWdConfig(cacheKey);
  if (config === undefined) {
    config = await discoverAllSiteSlugs(job.ats_slug);
    setWdConfig(cacheKey, config);
  }
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

async function fetchTaleoDescription(job) {
  if (!job.url) return null;
  const res = await fetch(job.url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const html = await res.text();
  // Try JSON-LD first
  const ld = extractJsonLdDescription(html);
  if (ld) return ld;
  // Extract from !*! delimited URL-encoded HTML in pipe data
  const PIPE_SEP = '!|!';
  if (html.includes('!*!') && html.includes(PIPE_SEP)) {
    const pipeStart = html.indexOf(PIPE_SEP);
    const pipeEnd = html.lastIndexOf(PIPE_SEP) + PIPE_SEP.length + 5000;
    const pipeSection = html.substring(pipeStart, Math.min(html.length, pipeEnd));
    const starParts = pipeSection.split('!*!');
    const descSegments = [];
    for (let i = 1; i < starParts.length; i++) {
      let raw = starParts[i];
      const pipeIdx = raw.indexOf(PIPE_SEP);
      if (pipeIdx !== -1) raw = raw.substring(0, pipeIdx);
      if (raw.length < 30) continue;
      try {
        const decoded = decodeURIComponent(raw);
        if (decoded.length > 50 && /<(p|li|br|ul|ol|div|span|h[1-6]|table|tr|td|strong|em|b|i)\b/i.test(decoded)) {
          descSegments.push(decoded);
        }
      } catch { /* skip */ }
    }
    if (descSegments.length > 0) return descSegments.join('\n');
  }
  return null;
}

async function fetchOracleDescription(job) {
  // Parse tenant.region.siteNumber from ats_slug
  const parts = job.ats_slug.split('.');
  if (parts.length < 2) return null;
  const tenant = parts[0];
  const region = parts[1];
  const siteNumber = parts.slice(2).join('.') || null;
  if (!siteNumber) return null;
  const jobId = job.external_id.replace('oracle_', '');
  const url = `https://${tenant}.fa.${region}.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?onlyData=true&expand=all&finder=ById;Id=${jobId},siteNumber=${siteNumber}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const data = await res.json();
  const item = data.items?.[0];
  if (!item) return null;
  const descParts = [item.ExternalDescriptionStr, item.ExternalQualificationsStr, item.ExternalResponsibilitiesStr].filter(Boolean);
  return descParts.length > 0 ? descParts.join('\n') : null;
}

async function fetchGreenhouseDescription(job) {
  const jobId = job.external_id.replace('greenhouse_', '');
  const res = await fetch(
    `https://api.greenhouse.io/v1/boards/${encodeURIComponent(job.ats_slug)}/jobs/${jobId}?questions=true`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.content || null;
}

async function fetchLeverDescription(job) {
  const jobId = job.external_id.replace('lever_', '');
  const res = await fetch(
    `https://api.lever.co/v0/postings/${encodeURIComponent(job.ats_slug)}/${jobId}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.descriptionPlain || data.description || null;
}

async function fetchAshbyDescription(job) {
  const jobId = job.external_id.replace('ashby_', '');
  const res = await fetch(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(job.ats_slug)}/job/${jobId}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.descriptionHtml || data.descriptionPlain || null;
}

async function fetchIcimsDescription(job) {
  const externalId = job.external_id.replace('icims_', '');
  // iCIMS iframe endpoint returns server-rendered HTML with JSON-LD
  const url = `https://${job.ats_slug}.icims.com/jobs/${externalId}/job?in_iframe=1`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const html = await res.text();
    // Extract description from JSON-LD (most reliable)
    const ld = extractJsonLdDescription(html);
    if (ld) return ld;
  } catch { /* timeout or network error */ }
  return null;
}

async function fetchPersonioDescription(job) {
  const res = await fetch(
    `https://${encodeURIComponent(job.ats_slug)}.jobs.personio.de/xml`,
    { signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) return null;
  const xml = await res.text();
  const positionId = job.external_id.replace('personio_', '');
  // Find the position block with matching ID
  const posRegex = new RegExp(`<position>([\\s\\S]*?)</position>`, 'g');
  let posMatch;
  while ((posMatch = posRegex.exec(xml)) !== null) {
    const block = posMatch[1];
    const idMatch = block.match(/<id>(\d+)<\/id>/);
    if (idMatch && idMatch[1] === positionId) {
      // Extract CDATA descriptions
      const sections = [];
      const descRegex = /<jobDescription>[\s\S]*?<name><!\[CDATA\[(.*?)\]\]><\/name>[\s\S]*?<value><!\[CDATA\[([\s\S]*?)\]\]><\/value>[\s\S]*?<\/jobDescription>/g;
      let descMatch;
      while ((descMatch = descRegex.exec(block)) !== null) {
        sections.push(`<h3>${descMatch[1]}</h3>${descMatch[2]}`);
      }
      if (sections.length > 0) return sections.join('\n');
    }
  }
  return null;
}

async function fetchRecruiteeDescription(job) {
  const jobId = job.external_id.replace('recruitee_', '');
  const res = await fetch(
    `https://${encodeURIComponent(job.ats_slug)}.recruitee.com/api/offers/${jobId}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.offer?.description || data.description || null;
}

async function fetchRipplingDescription(job) {
  const jobUuid = job.external_id.replace('rippling_', '');
  const res = await fetch(
    `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(job.ats_slug)}/jobs/${jobUuid}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const desc = data.description;
  if (!desc) return null;
  const parts = [desc.company, desc.role, desc.compensation].filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : null;
}

async function fetchZohoDescription(job) {
  if (!job.url) return null;
  const res = await fetch(job.url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const html = await res.text();
  const match = html.match(/var\s+jobs\s*=\s*JSON\.parse\('(.+?)'\)/);
  if (!match) return null;
  let raw = match[1].replace(/\\x22/g, '"').replace(/\\x27/g, "'");
  raw = raw.replace(/\\\\"/g, '\\"').replace(/\\\\:/g, ':').replace(/\\\\\//g, '/');
  try {
    const parsed = JSON.parse(raw);
    const jobData = Array.isArray(parsed) ? parsed[0] : parsed;
    return jobData?.Job_Description || null;
  } catch {
    const descMatch = raw.match(/"Job_Description"\s*:\s*"([\s\S]*?)"\s*,\s*"/);
    return descMatch ? descMatch[1].replace(/\\"/g, '"') : null;
  }
}

async function fetchWorkableDescription(job) {
  const shortcode = job.external_id.replace('workable_', '');
  const res = await fetch(
    `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(job.ats_slug)}/jobs/${shortcode}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const parts = [data.description, data.requirements, data.benefits].filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : null;
}

async function fetchJobviteDescription(job) {
  if (!job.url) return null;
  const res = await fetch(job.url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const html = await res.text();
  const ld = extractJsonLdDescription(html);
  if (ld) return ld;
  const ogMatch = html.match(/property="og:description"[^>]*content="([^"]*)"/i);
  return ogMatch?.[1]?.length > 50 ? ogMatch[1] : null;
}

async function fetchPinpointDescription(job) {
  const jobId = job.external_id.replace('pinpoint_', '');
  const res = await fetch(
    `https://${encodeURIComponent(job.ats_slug)}.pinpointhq.com/postings/${jobId}.json`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.description || data.attributes?.description || null;
}

async function fetchSuccessFactorsDescription(job) {
  if (!job.url) return null;
  const res = await fetch(job.url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const html = await res.text();
  const ld = extractJsonLdDescription(html);
  if (ld) return ld;
  return null;
}

async function fetchDescription(job) {
  const rawData = typeof job.raw_data === 'string' ? JSON.parse(job.raw_data) : job.raw_data;

  switch (job.ats) {
    case 'workday':
      return fetchWorkdayDescription(job, rawData);
    case 'taleo':
      return fetchTaleoDescription(job);
    case 'oracle':
      return fetchOracleDescription(job);
    case 'smartrecruiters':
      return fetchSmartRecruitersDescription(job);
    case 'bamboohr':
      return fetchBambooHRDescription(job);
    case 'jazzhr':
      return fetchJazzHRDescription(job);
    case 'breezy':
      return fetchBreezyDescription(job);
    case 'greenhouse':
      return fetchGreenhouseDescription(job);
    case 'lever':
      return fetchLeverDescription(job);
    case 'ashby':
      return fetchAshbyDescription(job);
    case 'icims':
      return fetchIcimsDescription(job);
    case 'personio':
      return fetchPersonioDescription(job);
    case 'recruitee':
      return fetchRecruiteeDescription(job);
    case 'rippling':
      return fetchRipplingDescription(job);
    case 'zoho':
      return fetchZohoDescription(job);
    case 'workable':
      return fetchWorkableDescription(job);
    case 'jobvite':
      return fetchJobviteDescription(job);
    case 'pinpoint':
      return fetchPinpointDescription(job);
    case 'successfactors':
      return fetchSuccessFactorsDescription(job);
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
  let consecutiveFailures = 0;

  for (const job of jobs) {
    try {
      const description = await fetchDescription(job);
      if (description) {
        await query('UPDATE jobs SET description = ? WHERE id = ?', [description, job.id]);
        filled++;
        consecutiveFailures = 0;
        metrics.increment(`backfill.filled.${ats}`);
      } else {
        failed++;
        consecutiveFailures++;
        metrics.increment(`backfill.failed.${ats}`);
      }
    } catch (err) {
      failed++;
      consecutiveFailures++;
      metrics.increment(`backfill.failed.${ats}`);
      logger.warn({ jobId: job.id, ats: job.ats, slug: job.ats_slug, err: err.message }, 'Backfill fetch failed');
    }

    // Exponential backoff after 3 consecutive failures (cap at 30s)
    let currentDelay = delayMs;
    if (consecutiveFailures >= 3) {
      currentDelay = Math.min(delayMs * Math.pow(2, consecutiveFailures - 2), 30000);
    }
    await new Promise(r => setTimeout(r, currentDelay));
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
