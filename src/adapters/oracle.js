/**
 * Oracle Cloud HCM adapter.
 * Uses the public recruitingCEJobRequisitions REST API.
 * Slug format: "{tenant}.{region}" e.g. "eeho.us2"
 * or "{tenant}.{region}.{siteNumber}" e.g. "eeho.us2.CX_45001"
 */
const logger = require('../logger');

const PAGE_SIZE = 25;
const DETAIL_BATCH_SIZE = 3;
const COMMON_SITE_NUMBERS = ['CX', 'CX_1', 'CX_1001', 'CX_45001', 'CX_1003'];

/**
 * Parse the slug into tenant, region, and siteNumber.
 * Slug format: "tenant.region" or "tenant.region.siteNumber"
 */
function parseSlug(slug) {
  const parts = slug.split('.');
  if (parts.length >= 3) {
    return { tenant: parts[0], region: parts[1], siteNumber: parts.slice(2).join('.') };
  }
  if (parts.length === 2) {
    return { tenant: parts[0], region: parts[1], siteNumber: null };
  }
  return null;
}

/**
 * Discover the siteNumber by trying common values.
 */
async function discoverSiteNumber(tenant, region) {
  for (const site of COMMON_SITE_NUMBERS) {
    try {
      const url = `https://${tenant}.fa.${region}.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&finder=findReqs;siteNumber=${site},limit=1,sortBy=POSTING_DATES_DESC`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.items?.length > 0 || data.count > 0) {
        return site;
      }
    } catch { /* try next */ }
  }
  logger.warn({ tenant, region, triedSites: COMMON_SITE_NUMBERS }, 'Oracle: no working siteNumber found');
  return null;
}

/**
 * Fetch full job details (description, qualifications, responsibilities).
 */
async function fetchJobDetail(baseUrl, siteNumber, jobId) {
  try {
    const url = `${baseUrl}/recruitingCEJobRequisitionDetails?onlyData=true&expand=all&finder=ById;Id=${jobId},siteNumber=${siteNumber}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    const item = data.items?.[0];
    if (!item) return null;
    const parts = [
      item.ExternalDescriptionStr,
      item.ExternalQualificationsStr,
      item.ExternalResponsibilitiesStr,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join('\n') : null;
  } catch {
    return null;
  }
}

async function fetchJobs(clientname) {
  const parsed = parseSlug(clientname);
  if (!parsed) throw new Error(`Oracle: invalid slug format "${clientname}", expected "tenant.region" or "tenant.region.siteNumber"`);

  const { tenant, region } = parsed;
  let siteNumber = parsed.siteNumber;

  if (!siteNumber) {
    siteNumber = await discoverSiteNumber(tenant, region);
    if (!siteNumber) throw new Error(`Oracle: could not discover siteNumber for ${tenant}.${region}`);
  }

  const baseUrl = `https://${tenant}.fa.${region}.oraclecloud.com/hcmRestApi/resources/latest`;

  // Step 1: Paginate through all job listings
  const postings = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore && offset < 5000) {
    const url = `${baseUrl}/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=${siteNumber},limit=${PAGE_SIZE},offset=${offset},sortBy=POSTING_DATES_DESC`;

    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Oracle HTTP ${res.status}`);
    const data = await res.json();

    const requisitions = data.items?.[0]?.requisitionList || [];
    if (requisitions.length === 0) break;

    postings.push(...requisitions);
    hasMore = requisitions.length === PAGE_SIZE;
    offset += PAGE_SIZE;
  }

  // Step 2: Fetch details in batches for full descriptions
  const jobs = [];

  for (let i = 0; i < postings.length; i += DETAIL_BATCH_SIZE) {
    const batch = postings.slice(i, i + DETAIL_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(job => fetchJobDetail(baseUrl, siteNumber, job.Id))
    );
    const details = settled.map(r => r.status === 'fulfilled' ? r.value : null);

    if (i + DETAIL_BATCH_SIZE < postings.length) {
      await new Promise(r => setTimeout(r, 300));
    }

    for (let j = 0; j < batch.length; j++) {
      const job = batch[j];
      const locations = [job.PrimaryLocation];
      if (job.secondaryLocations) {
        for (const sec of job.secondaryLocations) {
          if (sec.Name) locations.push(sec.Name);
        }
      }

      jobs.push({
        external_id: `oracle_${job.Id}`,
        title: job.Title,
        department: job.Department || job.JobFunction || null,
        location: locations.filter(Boolean).join('; ') || null,
        workplace_type: job.WorkplaceTypeCode === 'Remote' ? 'remote' : null,
        employment_type: job.JobType || job.JobSchedule || null,
        salary_min: null,
        salary_max: null,
        salary_currency: null,
        salary_interval: null,
        description: details[j] || job.ShortDescriptionStr || null,
        url: `https://${tenant}.fa.${region}.oraclecloud.com/hcmUI/CandidateExperience/en/sites/${siteNumber}/job/${job.Id}`,
        posted_at: job.PostedDate || null,
        raw_data: job,
      });
    }
  }

  logger.info({ tenant, region, siteNumber, fetched: jobs.length }, 'Oracle Cloud HCM fetch complete');

  return { jobs, meta: { companyName: null } };
}

module.exports = { fetchJobs };
