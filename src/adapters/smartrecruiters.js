async function fetchJobs(clientname) {
  const res = await fetch(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(clientname)}/postings`);
  if (!res.ok) throw new Error(`SmartRecruiters HTTP ${res.status}`);
  const data = await res.json();
  const jobs = (data.content || []).map(job => {
    const comp = job.compensation || {};
    return {
      external_id: `smartrecruiters_${job.id}`,
      title: job.name,
      department: job.department?.label || null,
      location: job.location?.fullLocation || job.location?.city || 'Remote',
      workplace_type: job.location?.remote ? 'remote' : null,
      employment_type: job.typeOfEmployment?.label || null,
      salary_min: comp.min || null,
      salary_max: comp.max || null,
      salary_currency: comp.currency || null,
      salary_interval: null,
      description: job.jobAd?.sections?.jobDescription?.text || null,
      url: `https://jobs.smartrecruiters.com/${encodeURIComponent(clientname)}/${job.id}`,
      posted_at: job.releasedDate || null,
      raw_data: job,
    };
  });

  return {
    jobs,
    meta: {
      companyName: data.content?.[0]?.company?.name || null,
      logoUrl: null,
    },
  };
}

module.exports = { fetchJobs };
