/**
 * Recruitee adapter. Public JSON feed: {slug}.recruitee.com/api/offers
 * One call returns all published offers with full descriptions — no per-job fetch.
 */
async function fetchJobs(clientname) {
  const res = await fetch(
    `https://${encodeURIComponent(clientname)}.recruitee.com/api/offers`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`Recruitee HTTP ${res.status}`);

  // Dead/closed accounts redirect to a marketing page (HTML). Guard so res.json()
  // doesn't throw an opaque parse error.
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    throw new Error(`Recruitee: "${clientname}" returned non-JSON (${contentType || 'unknown'})`);
  }

  const data = await res.json();
  const jobs = (data.offers || []).map(job => ({
    external_id: `recruitee_${job.id}`,
    title: job.title,
    department: job.department || null,
    location: job.location || [job.city, job.country].filter(Boolean).join(', ') || null,
    workplace_type: job.remote ? 'remote' : (job.hybrid ? 'hybrid' : (job.on_site ? 'onsite' : null)),
    employment_type: job.employment_type_code || null,
    // Salary is a nested object {min,max,currency,period} — the old flat paths (job.min_salary…)
    // never existed, so salary was always null.
    salary_min: job.salary?.min || null,
    salary_max: job.salary?.max || null,
    salary_currency: job.salary?.currency || null,
    salary_interval: job.salary?.period || null,
    description: job.description || null,
    url: job.careers_url || `https://${encodeURIComponent(clientname)}.recruitee.com/o/${job.slug || job.id}`,
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
