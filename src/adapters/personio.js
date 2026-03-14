async function fetchJobs(clientname) {
  const res = await fetch(
    `https://${encodeURIComponent(clientname)}.jobs.personio.de/search.json`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`Personio HTTP ${res.status}`);
  const data = await res.json();

  const jobs = (Array.isArray(data) ? data : []).map(job => ({
    external_id: `personio_${job.id}`,
    title: job.name,
    department: job.department || null,
    location: job.office || (job.offices && job.offices[0]) || null,
    workplace_type: null,
    employment_type: job.schedule || job.employment_type || null,
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    salary_interval: null,
    description: job.description || null,
    url: `https://${encodeURIComponent(clientname)}.jobs.personio.de/job/${job.id}?language=en`,
    posted_at: null,
    raw_data: job,
  }));

  return {
    jobs,
    meta: {
      companyName: jobs.length > 0 && data[0]?.subcompany ? data[0].subcompany : null,
    },
  };
}

module.exports = { fetchJobs };
