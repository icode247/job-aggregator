async function fetchJobs(clientname) {
  const res = await fetch(
    `https://${encodeURIComponent(clientname)}.breezy.hr/json`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`Breezy HTTP ${res.status}`);
  const data = await res.json();

  const jobs = (Array.isArray(data) ? data : []).map(job => ({
    external_id: `breezy_${job.id || job.friendly_id}`,
    title: job.name,
    department: job.department || null,
    location: job.location?.name || job.location?.city || null,
    workplace_type: job.is_remote ? 'remote' : null,
    employment_type: job.type?.name || null,
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    salary_interval: null,
    description: null,
    url: job.url || `https://${encodeURIComponent(clientname)}.breezy.hr/p/${job.friendly_id}`,
    posted_at: job.published_date || null,
    raw_data: job,
  }));

  const company = data[0]?.company || {};

  return {
    jobs,
    meta: {
      companyName: company.name || null,
      logoUrl: company.logo_url || null,
    },
  };
}

module.exports = { fetchJobs };
