const logger = require('../logger');

const WD_NUMBERS = [1, 2, 3, 5, 12];
const PAGE_SIZE = 20;
const DETAIL_BATCH_SIZE = 5;

/**
 * Discover the Workday instance number (wd1-wd12) and site slug
 * by checking robots.txt for each wd number.
 * Returns { wdNum, siteSlug } or null.
 */
async function discoverConfig(slug) {
  for (const wd of WD_NUMBERS) {
    try {
      const res = await fetch(
        `https://${slug}.wd${wd}.myworkdayjobs.com/robots.txt`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!res.ok) continue;
      const text = await res.text();
      const match = text.match(/Sitemap:.*myworkdayjobs\.com\/([^/\s]+)/);
      if (match) {
        return { wdNum: wd, siteSlug: match[1] };
      }
    } catch {
      // timeout or network error — try next
    }
  }
  return null;
}

/**
 * Fetch job detail for a single posting.
 */
async function fetchJobDetail(baseUrl, externalPath) {
  try {
    const res = await fetch(`${baseUrl}${externalPath}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Extract salary from job description HTML if present.
 */
function extractSalary(description) {
  if (!description) return {};
  // Match patterns like "$120,000 - $180,000" or "152,000 USD - 241,500 USD"
  // Require dollar sign or currency code to avoid matching random numbers
  const match = description.match(
    /\$([\d,]+(?:\.\d{2})?)\s*[-–]\s*\$([\d,]+(?:\.\d{2})?)|(?:base[^.]*?)([\d,]+(?:\.\d{2})?)\s*(USD|CAD|GBP|EUR)\s*[-–]\s*([\d,]+(?:\.\d{2})?)\s*(USD|CAD|GBP|EUR)/i
  );
  if (match) {
    if (match[1] && match[2]) {
      const min = parseInt(match[1].replace(/,/g, ''), 10);
      const max = parseInt(match[2].replace(/,/g, ''), 10);
      if (min >= 10000 && max >= 10000 && max < 10000000) {
        return { salary_min: String(min), salary_max: String(max), salary_currency: 'USD' };
      }
    }
    if (match[3] && match[5]) {
      const min = parseInt(match[3].replace(/,/g, ''), 10);
      const max = parseInt(match[5].replace(/,/g, ''), 10);
      if (min >= 10000 && max >= 10000 && max < 10000000) {
        return { salary_min: String(min), salary_max: String(max), salary_currency: match[4] || match[6] || 'USD' };
      }
    }
  }
  return {};
}

/**
 * Fetch all jobs from a Workday career site with full details.
 */
async function fetchJobs(clientname) {
  const config = await discoverConfig(clientname);
  if (!config) throw new Error(`Workday: could not discover config for ${clientname}`);

  const { wdNum, siteSlug } = config;
  const baseUrl = `https://${clientname}.wd${wdNum}.myworkdayjobs.com/wday/cxs/${clientname}/${siteSlug}`;

  // Step 1: Collect all postings from listing endpoint
  const postings = [];
  let offset = 0;

  while (offset < 5000) {
    const res = await fetch(`${baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appliedFacets: {},
        limit: PAGE_SIZE,
        offset,
        searchText: '',
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) throw new Error(`Workday HTTP ${res.status}`);
    const data = await res.json();
    const page = data.jobPostings || [];

    if (page.length === 0) break;
    postings.push(...page);
    offset += PAGE_SIZE;
    if (page.length < PAGE_SIZE) break;
  }

  // Step 2: Fetch details in batches
  const jobs = [];
  let companyName = null;

  for (let i = 0; i < postings.length; i += DETAIL_BATCH_SIZE) {
    const batch = postings.slice(i, i + DETAIL_BATCH_SIZE);
    const details = await Promise.all(
      batch.map(p => fetchJobDetail(baseUrl, p.externalPath))
    );

    for (let j = 0; j < batch.length; j++) {
      const posting = batch[j];
      const detail = details[j]?.jobPostingInfo || null;
      const jobReqId = posting.bulletFields?.[0] || null;
      const description = detail?.jobDescription || null;
      const salary = extractSalary(description);

      if (!companyName && details[j]?.hiringOrganization?.name) {
        companyName = details[j].hiringOrganization.name;
      }

      jobs.push({
        external_id: `workday_${jobReqId || posting.externalPath}`,
        title: posting.title,
        department: null,
        location: detail?.location || posting.locationsText || null,
        workplace_type: null,
        employment_type: detail?.timeType || null,
        salary_min: salary.salary_min || null,
        salary_max: salary.salary_max || null,
        salary_currency: salary.salary_currency || null,
        salary_interval: null,
        description,
        url: detail?.externalUrl || `https://${clientname}.wd${wdNum}.myworkdayjobs.com/${siteSlug}${posting.externalPath}`,
        posted_at: detail?.startDate || null,
        raw_data: posting,
      });
    }
  }

  logger.info({ slug: clientname, wdNum, siteSlug, fetched: jobs.length }, 'Workday fetch complete');

  return { jobs, meta: { companyName } };
}

module.exports = { fetchJobs, discoverConfig };
