// Teamtailor adapter — uses each company's public JSON Feed at {slug}.teamtailor.com/jobs.json.
// No auth, works direct. The feed carries the FULL job description (content_html) plus a JSON-LD
// JobPosting (_jobposting) with location/company/dates, so teamtailor jobs need NO description
// backfill. NOTE: the feed is capped at 100 jobs per company (no pagination); companies with >100
// open roles are truncated to the 100 most recent — rare, since most teamtailor tenants are small.
const CAP_HINT = 100;

function normalizeLocation(jp) {
  const place = Array.isArray(jp?.jobLocation) ? jp.jobLocation[0] : jp?.jobLocation;
  const a = place?.address;
  if (!a) return jp?.jobLocationType === 'TELECOMMUTE' ? 'Remote' : null;
  const parts = [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean);
  const loc = parts.join(', ');
  return loc || (jp?.jobLocationType === 'TELECOMMUTE' ? 'Remote' : null);
}

async function fetchJobs(clientname) {
  const res = await fetch(`https://${encodeURIComponent(clientname)}.teamtailor.com/jobs.json`, {
    headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Teamtailor HTTP ${res.status}`);
  const data = await res.json();
  const items = data.items || [];
  const jobs = items.map((it) => {
    const jp = it._jobposting || {};
    const remote = jp.jobLocationType === 'TELECOMMUTE';
    return {
      external_id: `teamtailor_${it.id}`,
      title: it.title || jp.title || null,
      department: jp.industry || null,
      location: normalizeLocation(jp),
      workplace_type: remote ? 'remote' : null,
      employment_type: jp.employmentType || null,
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      salary_interval: null,
      description: it.content_html || jp.description || null, // full description — no backfill needed
      url: it.url,
      posted_at: it.date_published || jp.datePosted || null,
      raw_data: it,
    };
  });
  if (items.length >= CAP_HINT) {
    // Signal truncation via meta so callers can log it; the feed gives no total count.
    return { jobs, meta: { companyName: null, logoUrl: null, truncated: true } };
  }
  return { jobs, meta: { companyName: null, logoUrl: null } };
}

module.exports = { fetchJobs };
