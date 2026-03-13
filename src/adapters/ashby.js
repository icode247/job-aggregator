async function fetchJobs(clientname) {
  const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(clientname)}?includeCompensation=true`);
  if (!res.ok) throw new Error(`Ashby HTTP ${res.status}`);
  const data = await res.json();
  const jobs = (data.jobs || []).map(job => {
    const comp = job.compensation;
    return {
      external_id: `ashby_${job.id}`,
      title: job.title,
      department: job.department || job.team || null,
      location: job.location || 'Remote',
      workplace_type: job.workplaceType || null,
      employment_type: job.employmentType || null,
      salary_min: comp?.compensationTierSummary?.[0]?.min || null,
      salary_max: comp?.compensationTierSummary?.[0]?.max || null,
      salary_currency: comp?.compensationTierSummary?.[0]?.currency || null,
      salary_interval: comp?.compensationTierSummary?.[0]?.interval || null,
      description: job.descriptionHtml || job.descriptionPlain || null,
      url: job.jobUrl,
      posted_at: job.publishedAt || null,
      raw_data: job,
    };
  });

  return {
    jobs,
    meta: {
      companyName: data.organizationName || null,
      logoUrl: data.organizationLogo || null,
    },
  };
}

module.exports = { fetchJobs };
