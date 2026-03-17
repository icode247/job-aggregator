/**
 * iCIMS adapter for Jibe-powered career sites.
 * Uses the public /api/jobs JSON endpoint.
 * Career site must be Jibe-powered (check for window._jibe in source).
 */
async function fetchJobs(clientname) {
  // iCIMS Jibe sites use custom domains, but for dictionary crawl
  // we probe with the format: https://{slug}.icims.com/api/jobs
  // or the direct custom domain pattern
  const urls = [
    `https://careers.${clientname}.com/api/jobs`,
    `https://jobs.${clientname}.com/api/jobs`,
    `https://careers-${clientname}.icims.com/api/jobs`,
    `https://${clientname}.icims.com/api/jobs`,
  ];

  let data = null;
  let baseUrl = null;

  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const text = await res.text();
        if (text.startsWith('{') || text.startsWith('[')) {
          data = JSON.parse(text);
          baseUrl = url.replace('/api/jobs', '');
          break;
        }
      }
    } catch { /* try next */ }
  }

  if (!data || !Array.isArray(data.jobs)) {
    throw new Error(`iCIMS: no working endpoint found for ${clientname}`);
  }

  const jobs = (data.jobs || []).map(entry => {
    const job = entry.data || entry;
    return {
      external_id: `icims_${job.req_id || job.slug}`,
      title: job.title,
      department: job.categories?.[0]?.name || null,
      location: job.full_location || job.short_location || job.location_name || null,
      workplace_type: (job.tags2 || []).some(t => t.toLowerCase().includes('remote')) ? 'remote' : null,
      employment_type: job.employment_type?.replace('_', ' ') || null,
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      salary_interval: null,
      description: [job.description, job.responsibilities, job.qualifications].filter(Boolean).join('\n'),
      url: job.apply_url || `${baseUrl}/jobs/${job.slug}`,
      posted_at: job.posted_date || job.create_date || null,
      raw_data: job,
    };
  });

  const firstJob = data.jobs?.[0]?.data || {};
  const orgName = firstJob.hiring_organization || null;
  const logoUrl = firstJob.hiring_organization_logo || null;

  return {
    jobs,
    meta: {
      companyName: orgName,
      logoUrl,
    },
  };
}

module.exports = { fetchJobs };
