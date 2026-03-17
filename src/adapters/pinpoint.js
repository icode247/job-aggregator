const logger = require('../logger');

async function fetchJobs(clientname) {
  const res = await fetch(
    `https://${encodeURIComponent(clientname)}.pinpointhq.com/postings.json`,
    { signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error(`Pinpoint HTTP ${res.status}`);
  const data = await res.json();
  const listings = data.data || data.postings || data || [];
  const jobsArray = Array.isArray(listings) ? listings : [];

  const jobs = jobsArray.map(job => ({
    external_id: `pinpoint_${job.id}`,
    title: job.title || job.attributes?.title,
    department: job.department?.name || job.attributes?.department || null,
    location: job.location?.name || job.attributes?.location || null,
    workplace_type: job.remote ? 'remote' : null,
    employment_type: job.employment_type || job.attributes?.employment_type || null,
    salary_min: null, salary_max: null, salary_currency: null, salary_interval: null,
    description: job.description || job.attributes?.description || null,
    url: job.url || `https://${clientname}.pinpointhq.com/postings/${job.id}`,
    posted_at: job.published_at || job.created_at || null,
    raw_data: job,
  }));

  return { jobs, meta: { companyName: null } };
}

module.exports = { fetchJobs };
