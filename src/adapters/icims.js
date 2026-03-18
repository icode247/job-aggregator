/**
 * iCIMS adapter.
 * Supports two types of iCIMS career sites:
 * 1. Jibe-powered sites with /api/jobs JSON endpoint
 * 2. Classic iCIMS portals at {slug}.icims.com with HTML scraping
 *
 * Slug formats from crawlers:
 * - "careers-{company}" → tries {slug}.icims.com, careers.{company}.com
 * - "{company}" → tries careers.{company}.com, {company}.icims.com
 */
const logger = require('../logger');

async function fetchJobs(clientname) {
  // Build URL candidates based on slug format
  const urls = [];

  if (clientname.includes('-')) {
    // e.g. "careers-nasco" → careers-nasco.icims.com first
    urls.push(`https://${clientname}.icims.com/api/jobs`);
    const parts = clientname.split('-');
    if (['careers', 'jobs', 'globalcareers'].includes(parts[0])) {
      const company = parts.slice(1).join('-');
      urls.push(`https://careers.${company}.com/api/jobs`);
      urls.push(`https://jobs.${company}.com/api/jobs`);
    }
  } else {
    urls.push(`https://careers.${clientname}.com/api/jobs`);
    urls.push(`https://jobs.${clientname}.com/api/jobs`);
    urls.push(`https://${clientname}.icims.com/api/jobs`);
  }

  // Try Jibe-powered JSON endpoints first
  let data = null;
  let baseUrl = null;

  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('json')) continue;
      const text = await res.text();
      if (text.startsWith('{') || text.startsWith('[')) {
        data = JSON.parse(text);
        baseUrl = url.replace('/api/jobs', '');
        break;
      }
    } catch { /* try next */ }
  }

  if (data && Array.isArray(data.jobs)) {
    return parseJibeResponse(data, baseUrl);
  }

  // Fallback: try classic iCIMS HTML portal
  const portalUrl = `https://${clientname}.icims.com`;
  try {
    const jobs = await scrapeClassicPortal(portalUrl, clientname);
    if (jobs.length > 0) {
      return { jobs, meta: { companyName: null, logoUrl: null } };
    }
  } catch (err) {
    logger.debug({ err: err.message, clientname }, 'iCIMS classic portal failed');
  }

  throw new Error(`iCIMS: no working endpoint found for ${clientname}`);
}

function parseJibeResponse(data, baseUrl) {
  const jobs = (data.jobs || []).map(entry => {
    const job = entry.data || entry;
    return {
      external_id: `icims_${job.req_id || job.slug}`,
      title: job.title,
      department: job.categories?.[0]?.name || null,
      location: job.full_location || job.short_location || job.location_name || null,
      workplace_type: (job.tags2 || []).some(t => t.toLowerCase().includes('remote')) ? 'remote' : null,
      employment_type: job.employment_type?.replace('_', ' ') || null,
      salary_min: null, salary_max: null, salary_currency: null, salary_interval: null,
      description: [job.description, job.responsibilities, job.qualifications].filter(Boolean).join('\n'),
      url: job.apply_url || `${baseUrl}/jobs/${job.slug}`,
      posted_at: job.posted_date || job.create_date || null,
      raw_data: job,
    };
  });

  const firstJob = data.jobs?.[0]?.data || {};
  return {
    jobs,
    meta: {
      companyName: firstJob.hiring_organization || null,
      logoUrl: firstJob.hiring_organization_logo || null,
    },
  };
}

/**
 * Scrape classic iCIMS portal HTML for job listings.
 */
async function scrapeClassicPortal(portalUrl, clientname) {
  const searchUrl = `${portalUrl}/jobs/search?ss=1&searchKeyword=&searchLocation=&mobile=false&listFilterMode=1`;
  const res = await fetch(searchUrl, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`iCIMS classic HTTP ${res.status}`);

  const html = await res.text();
  if (!html.includes('icims') && !html.includes('iCIMS')) {
    throw new Error('Not an iCIMS portal');
  }

  const jobs = [];
  const linkRegex = /href="([^"]*\/jobs\/(\d+)[^"]*)"/gi;
  const seen = new Set();

  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const jobUrl = match[1];
    const jobId = match[2];
    if (seen.has(jobId)) continue;
    seen.add(jobId);

    // Extract title near the link
    let title = `Job ${jobId}`;
    const ctx = html.substring(Math.max(0, match.index - 300), match.index + 300);
    const titleMatch = ctx.match(/<(?:a|span|div)[^>]*class="[^"]*title[^"]*"[^>]*>([^<]{3,100})/i)
      || ctx.match(/>([A-Z][^<]{5,80})<\/a>/);
    if (titleMatch) title = titleMatch[1].trim();

    const fullUrl = jobUrl.startsWith('http') ? jobUrl : `${portalUrl}${jobUrl}`;
    jobs.push({
      external_id: `icims_${jobId}`,
      title,
      department: null, location: null, workplace_type: null, employment_type: null,
      salary_min: null, salary_max: null, salary_currency: null, salary_interval: null,
      description: null,
      url: fullUrl,
      posted_at: null,
      raw_data: { id: jobId },
    });
  }

  logger.info({ clientname, jobs: jobs.length, source: 'classic' }, 'iCIMS classic portal scraped');
  return jobs;
}

module.exports = { fetchJobs };
