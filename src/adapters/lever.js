async function fetchJobs(clientname) {
  const res = await fetch(`https://api.lever.co/v0/postings/${encodeURIComponent(clientname)}`);
  if (!res.ok) throw new Error(`Lever HTTP ${res.status}`);
  const data = await res.json();
  const jobs = (Array.isArray(data) ? data : []).map(job => {
    const salary = job.salaryRange || {};
    return {
      external_id: `lever_${job.id}`,
      title: job.text,
      department: job.categories?.team || job.categories?.department || null,
      location: job.categories?.location || 'Remote',
      workplace_type: job.workplaceType || null,
      employment_type: job.categories?.commitment || null,
      salary_min: salary.min || null,
      salary_max: salary.max || null,
      salary_currency: salary.currency || null,
      salary_interval: salary.interval || null,
      description: job.descriptionPlain || job.description || null,
      url: job.hostedUrl,
      posted_at: job.createdAt ? new Date(job.createdAt).toISOString() : null,
      raw_data: job,
    };
  });

  return {
    jobs,
    meta: {
      companyName: null,
      logoUrl: null,
    },
  };
}

module.exports = { fetchJobs };
