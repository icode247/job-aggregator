async function fetchJobs(clientname) {
  const res = await fetch(`https://api.greenhouse.io/v1/boards/${encodeURIComponent(clientname)}/jobs?content=true`);
  if (!res.ok) throw new Error(`Greenhouse HTTP ${res.status}`);
  const data = await res.json();
  const jobs = (data.jobs || []).map(job => ({
    external_id: `greenhouse_${job.id}`,
    title: job.title,
    department: job.departments?.[0]?.name || null,
    location: job.location?.name || 'Remote',
    workplace_type: null,
    employment_type: null,
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    salary_interval: null,
    description: job.content || null,
    url: job.absolute_url,
    posted_at: job.updated_at || null,
    raw_data: job,
  }));

  return { jobs, meta: {} };
}

async function fetchCompanyMeta(clientname) {
  const res = await fetch(`https://api.greenhouse.io/v1/boards/${encodeURIComponent(clientname)}`);
  if (!res.ok) return null;
  const data = await res.json();
  return {
    companyName: data.name || null,
    logoUrl: data.logo || null,
  };
}

module.exports = { fetchJobs, fetchCompanyMeta };
