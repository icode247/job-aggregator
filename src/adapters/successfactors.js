const logger = require('../logger');

const PAGE_SIZE = 100;

async function fetchJobs(clientname) {
  // SuccessFactors uses company-specific career sites
  // Common patterns: {company}.successfactors.eu, careercenter-{company}.sap.com
  const baseUrls = [
    `https://career${clientname}.successfactors.eu/career`,
    `https://${clientname}.successfactors.com/career`,
    `https://career${clientname}.sap.com/career`,
  ];

  let jobsUrl = null;
  for (const base of baseUrls) {
    try {
      const res = await fetch(`${base}?company=${clientname}&career_ns=job_listing_summary&navBarLevel=JOB_SEARCH&rcm_siteid=0&pageNum=1&rows=${PAGE_SIZE}&_=1`,
        { signal: AbortSignal.timeout(10000) });
      if (res.ok) { jobsUrl = base; break; }
    } catch { /* try next */ }
  }

  if (!jobsUrl) throw new Error(`SuccessFactors: no working endpoint for ${clientname}`);

  const allJobs = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const res = await fetch(
      `${jobsUrl}?company=${clientname}&career_ns=job_listing_summary&navBarLevel=JOB_SEARCH&rcm_siteid=0&pageNum=${page}&rows=${PAGE_SIZE}`,
      { signal: AbortSignal.timeout(15000) }
    );
    if (!res.ok) break;
    const html = await res.text();

    // Extract job data from HTML/JSON response
    const jobRegex = /jobId["\s:]+["']?(\d+)["']?[\s\S]*?jobTitle["\s:]+["']([^"']+)["']/g;
    let match;
    let foundInPage = 0;
    while ((match = jobRegex.exec(html)) !== null) {
      allJobs.push({
        external_id: `successfactors_${match[1]}`,
        title: match[2],
        department: null, location: null, workplace_type: null, employment_type: null,
        salary_min: null, salary_max: null, salary_currency: null, salary_interval: null,
        description: null,
        url: `${jobsUrl}?company=${clientname}&career_job_req_id=${match[1]}&career_ns=job_listing&navBarLevel=JOB_SEARCH`,
        posted_at: null,
        raw_data: { jobId: match[1] },
      });
      foundInPage++;
    }

    hasMore = foundInPage >= PAGE_SIZE;
    page++;
    if (page > 50) break; // Safety limit
  }

  return { jobs: allJobs, meta: { companyName: null } };
}

module.exports = { fetchJobs };
