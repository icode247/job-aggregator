async function fetchJobs(clientname) {
  const res = await fetch(`https://${encodeURIComponent(clientname)}.recruitee.com/api/offers`);
  if (!res.ok) throw new Error(`Recruitee HTTP ${res.status}`);
  const data = await res.json();
  const jobs = (data.offers || []).map(job => ({
    external_id: `recruitee_${job.id}`,
    title: job.title,
    department: job.department || null,
    location: job.location || 'Remote',
    workplace_type: job.remote ? 'Remote' : (job.workplace_type || null),
    employment_type: job.employment_type_code || null,
    salary_min: job.min_salary || null,
    salary_max: job.max_salary || null,
    salary_currency: job.salary_currency || null,
    salary_interval: null,
    description: job.description || null,
    url: job.careers_url,
    posted_at: job.published_at || null,
    raw_data: job,
  }));

  return {
    jobs,
    meta: {
      companyName: data.company?.name || null,
      logoUrl: data.company?.logo_url || null,
    },
  };
}

module.exports = { fetchJobs };
