const logger = require('../logger');

const DETAIL_BATCH_SIZE = 3;
const DETAIL_DELAY_MS = 1000;

async function fetchJobs(clientname) {
  // v3 API: single POST, returns all jobs
  const listRes = await fetch(
    `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(clientname)}/jobs`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15000),
    }
  );
  if (listRes.status === 429) {
    throw new Error('Workable rate limited (429) — will retry next cycle');
  }
  if (!listRes.ok) throw new Error(`Workable HTTP ${listRes.status}`);
  const listData = await listRes.json();
  const listings = listData.results || [];

  const jobs = listings.map(listing => {
    const loc = listing.location || {};
    return {
      external_id: `workable_${listing.shortcode}`,
      title: listing.title,
      department: listing.department?.[0] || null,
      location: [loc.city, loc.region, loc.country].filter(Boolean).join(', ') || 'Remote',
      workplace_type: listing.remote ? 'Remote' : (listing.workplace || null),
      employment_type: listing.type === 'full' ? 'Full-time' : listing.type === 'part' ? 'Part-time' : listing.type || null,
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      salary_interval: null,
      description: null,
      url: `https://apply.workable.com/${encodeURIComponent(clientname)}/j/${listing.shortcode}/`,
      posted_at: listing.published || null,
      raw_data: listing,
    };
  });

  // Fetch descriptions from v2 detail API in small batches
  for (let i = 0; i < jobs.length; i += DETAIL_BATCH_SIZE) {
    const batch = jobs.slice(i, i + DETAIL_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(job => fetchJobDetail(clientname, job.external_id.replace('workable_', '')))
    );

    for (let j = 0; j < batch.length; j++) {
      const detail = settled[j].status === 'fulfilled' ? settled[j].value : null;
      if (!detail) continue;
      if (detail.description) batch[j].description = detail.description;
      if (detail.salary_min) batch[j].salary_min = detail.salary_min;
      if (detail.salary_max) batch[j].salary_max = detail.salary_max;
      if (detail.salary_currency) batch[j].salary_currency = detail.salary_currency;
    }

    if (i + DETAIL_BATCH_SIZE < jobs.length) {
      await new Promise(r => setTimeout(r, DETAIL_DELAY_MS));
    }
  }

  // Logo from v1 widget
  let companyName = null;
  let logoUrl = null;
  try {
    const widgetRes = await fetch(
      `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(clientname)}`,
      { signal: AbortSignal.timeout(3000) }
    );
    if (widgetRes.ok) {
      const widget = await widgetRes.json();
      companyName = widget.name || null;
      logoUrl = widget.logo || null;
    }
  } catch {}

  return { jobs, meta: { companyName, logoUrl } };
}

async function fetchJobDetail(accountSlug, shortcode) {
  try {
    const res = await fetch(
      `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(accountSlug)}/jobs/${shortcode}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (res.status === 429) return null; // Don't throw, just skip
    if (!res.ok) return null;
    const data = await res.json();

    const descParts = [data.description, data.requirements, data.benefits].filter(Boolean);
    const description = descParts.length > 0 ? descParts.join('\n') : null;

    // Extract salary from benefits text
    let salary_min = null, salary_max = null, salary_currency = null;
    const benefitsText = data.benefits || '';
    const salaryMatch = benefitsText.match(/\$([0-9,]+)\s*[-–to]+\s*\$([0-9,]+)/);
    if (salaryMatch) {
      salary_min = parseInt(salaryMatch[1].replace(/,/g, ''), 10);
      salary_max = parseInt(salaryMatch[2].replace(/,/g, ''), 10);
      salary_currency = 'USD';
    }

    return { description, salary_min, salary_max, salary_currency };
  } catch {
    return null;
  }
}

module.exports = { fetchJobs };
