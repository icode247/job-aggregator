async function fetchJobs(clientname) {
  const res = await fetch(`https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(clientname)}/jobs`);
  if (!res.ok) throw new Error(`Rippling HTTP ${res.status}`);
  const data = await res.json();
  const listings = Array.isArray(data) ? data : Object.values(data);
  const jobs = listings.map(job => ({
    external_id: `rippling_${job.uuid}`,
    title: job.name,
    department: job.department?.label || job.department || null,
    location: job.workLocation?.label || 'Remote',
    workplace_type: null,
    employment_type: null,
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    salary_interval: null,
    description: job.description || null,
    url: job.url || `https://ats.rippling.com/${encodeURIComponent(clientname)}/jobs/${job.uuid}`,
    posted_at: null,
    raw_data: job,
  }));

  return { jobs, meta: {} };
}

module.exports = { fetchJobs };
