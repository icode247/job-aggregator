async function fetchJobs(clientname) {
  const res = await fetch(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(clientname)}`);
  if (!res.ok) throw new Error(`Workable HTTP ${res.status}`);
  const data = await res.json();
  const jobs = (data.jobs || []).map(job => ({
    external_id: `workable_${job.id}`,
    title: job.title,
    department: job.department || null,
    location: [job.city, job.state, job.country].filter(Boolean).join(', ') || 'Remote',
    workplace_type: job.telecommuting ? 'Remote' : 'On-site',
    employment_type: job.employment_type || null,
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    salary_interval: null,
    description: job.description || null,
    url: job.url,
    posted_at: job.published_on || null,
    raw_data: job,
  }));

  return {
    jobs,
    meta: {
      companyName: data.name || null,
      logoUrl: data.logo || null,
    },
  };
}

module.exports = { fetchJobs };
