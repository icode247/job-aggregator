const DETAIL_BATCH_SIZE = 1;

async function fetchJobDetail(clientname, shortcode) {
  try {
    const res = await fetch(
      `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(clientname)}/jobs/${shortcode}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchJobs(clientname) {
  const res = await fetch(
    `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(clientname)}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`Workable HTTP ${res.status}`);
  const data = await res.json();
  const listings = data.jobs || [];

  // Fetch details in batches for descriptions
  const jobs = [];

  for (let i = 0; i < listings.length; i += DETAIL_BATCH_SIZE) {
    const batch = listings.slice(i, i + DETAIL_BATCH_SIZE);
    const details = await Promise.all(
      batch.map(j => fetchJobDetail(clientname, j.shortcode))
    );

    for (let k = 0; k < batch.length; k++) {
      const job = batch[k];
      const detail = details[k];

      jobs.push({
        external_id: `workable_${job.shortcode}`,
        title: job.title,
        department: job.department || null,
        location: [job.city, job.state, job.country].filter(Boolean).join(', ') || 'Remote',
        workplace_type: job.telecommuting ? 'Remote' : 'On-site',
        employment_type: job.employment_type || null,
        salary_min: null,
        salary_max: null,
        salary_currency: null,
        salary_interval: null,
        description: detail?.description || null,
        url: job.url || job.shortlink,
        posted_at: job.published_on || null,
        raw_data: job,
      });
    }

    // Pause between batches — Workable rate limits aggressively
    if (i + DETAIL_BATCH_SIZE < listings.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  return {
    jobs,
    meta: {
      companyName: data.name || null,
      logoUrl: data.logo || null,
    },
  };
}

module.exports = { fetchJobs };
