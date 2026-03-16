async function fetchJobs(clientname) {
  // v3 API: single POST, returns all jobs — no rate limit issues
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

  // Try ONE detail fetch to get description format — if it works, fetch all
  // If it fails, save jobs without descriptions (they'll get backfilled)
  if (jobs.length > 0) {
    try {
      const testRes = await fetch(
        `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(clientname)}/jobs/${listings[0].shortcode}`,
        { signal: AbortSignal.timeout(3000) }
      );
      if (testRes.ok) {
        const testDetail = await testRes.json();
        const parts = [testDetail.description, testDetail.requirements, testDetail.benefits].filter(Boolean);
        jobs[0].description = parts.join('\n') || null;

        // First one worked — fetch rest with short timeout
        for (let i = 1; i < listings.length; i++) {
          try {
            const res = await fetch(
              `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(clientname)}/jobs/${listings[i].shortcode}`,
              { signal: AbortSignal.timeout(3000) }
            );
            if (res.ok) {
              const d = await res.json();
              jobs[i].description = [d.description, d.requirements, d.benefits].filter(Boolean).join('\n') || null;
            }
          } catch { break; } // Stop on first failure
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    } catch {
      // v2 API blocked — save without descriptions
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

module.exports = { fetchJobs };
