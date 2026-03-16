const { fetchUnlockedHtml } = require('./brightdata');

async function fetchJobs(clientname) {
  // Use v3 API for listing — single POST, returns all jobs
  const listRes = await fetch(
    `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(clientname)}/jobs`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10000),
    }
  );
  if (!listRes.ok) throw new Error(`Workable HTTP ${listRes.status}`);
  const listData = await listRes.json();
  const listings = listData.results || [];

  // Fetch descriptions from v2 API one at a time
  const jobs = [];

  for (const listing of listings) {
    let description = null;

    try {
      const detailRes = await fetch(
        `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(clientname)}/jobs/${listing.shortcode}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (detailRes.ok) {
        const detail = await detailRes.json();
        const parts = [detail.description, detail.requirements, detail.benefits].filter(Boolean);
        description = parts.join('\n') || null;
      }
    } catch { /* skip description */ }

    const loc = listing.location || {};
    jobs.push({
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
      description,
      url: `https://apply.workable.com/${encodeURIComponent(clientname)}/j/${listing.shortcode}/`,
      posted_at: listing.published || null,
      raw_data: listing,
    });

    // Delay between detail requests
    if (jobs.length < listings.length) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // Get logo from the v1 widget API (single call)
  let companyName = null;
  let logoUrl = null;
  try {
    const widgetRes = await fetch(
      `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(clientname)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (widgetRes.ok) {
      const widget = await widgetRes.json();
      companyName = widget.name || null;
      logoUrl = widget.logo || null;
    }
  } catch { /* skip */ }

  return { jobs, meta: { companyName, logoUrl } };
}

module.exports = { fetchJobs };
