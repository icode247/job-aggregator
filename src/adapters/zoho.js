/**
 * Zoho Recruit adapter.
 * Job data is embedded in a hidden <input id="jobs"> field as HTML-encoded JSON.
 * Company meta is in <input id="meta">.
 */
const ZOHO_DOMAINS = [
  'zohorecruit.com',
  'zohorecruit.in',
  'zohorecruit.eu',
  'zohorecruit.com.au',
];

const DETAIL_BATCH_SIZE = 3;

function titleSlug(title) {
  return (title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function fetchJobDetail(domain, clientname, jobId, slug) {
  try {
    const url = `https://${clientname}.${domain}/jobs/Careers/${jobId}/${slug}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/var\s+jobs\s*=\s*JSON\.parse\('(.+?)'\)/);
    if (!match) return null;
    // Decode \x22 → " and \x27 → ', then fix escaped inner quotes
    let raw = match[1].replace(/\\x22/g, '"').replace(/\\x27/g, "'");
    // The JSON contains \\" (escaped quotes inside string values) — convert to escaped form JSON expects
    raw = raw.replace(/\\\\"/g, '\\"');
    // Also handle escaped colons and other Zoho quirks
    raw = raw.replace(/\\\\:/g, ':').replace(/\\\\\//g, '/');
    try {
      const parsed = JSON.parse(raw);
      const job = Array.isArray(parsed) ? parsed[0] : parsed;
      return job?.Job_Description || null;
    } catch {
      // If JSON parse fails, extract the Job_Description as a proper JSON string value:
      // (?:[^"\\]|\\.)* matches any char except an UNescaped quote, so it stops only at the real
      // closing quote — the old `([\s\S]*?)"\s*,\s*"` truncated at the first \",\" inside the HTML.
      const descMatch = raw.match(/"Job_Description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      return descMatch ? descMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n') : null;
    }
  } catch {
    return null;
  }
}

async function fetchJobs(clientname) {
  let html = null;
  let workingDomain = null;

  for (const domain of ZOHO_DOMAINS) {
    try {
      const res = await fetch(
        `https://${encodeURIComponent(clientname)}.${domain}/jobs/Careers`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (res.ok) {
        const text = await res.text();
        if (text.includes('id="jobs"')) {
          html = text;
          workingDomain = domain;
          break;
        }
      }
    } catch { /* try next domain */ }
  }

  if (!html) throw new Error(`Zoho HTTP: no working domain for ${clientname}`);

  // Extract hidden input fields — value can come before or after id
  function extractInput(id) {
    // Try: value before id
    let regex = new RegExp(`<input[^>]*value="([^"]*)"[^>]*id="${id}"`, 'i');
    let match = html.match(regex);
    // Try: id before value
    if (!match) {
      regex = new RegExp(`<input[^>]*id="${id}"[^>]*value="([^"]*)"`, 'i');
      match = html.match(regex);
    }
    // Try: content between tags
    if (!match) {
      regex = new RegExp(`id="${id}">([^<]+)<`, 'i');
      match = html.match(regex);
    }
    if (!match || !match[1] || match[1] === '[]') return null;
    // Decode HTML entities
    const decoded = match[1]
      .replace(/&#34;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    try { return JSON.parse(decoded); } catch { return null; }
  }

  const jobsData = extractInput('jobs');
  const metaData = extractInput('meta');

  if (!jobsData || !Array.isArray(jobsData)) {
    return { jobs: [], meta: {} };
  }

  const jobs = jobsData
    .filter(job => job.Publish !== false)
    .map(job => ({
      external_id: `zoho_${job.id}`,
      title: job.Posting_Title || job.Job_Opening_Name || null,
      // Field is `Country` (the old `Country1` never existed, so country was dropped from every
      // location — jobs with only a country came out null). Keep Country1 as a fallback just in case.
      location: [job.City, job.State, job.Country || job.Country1].filter(Boolean).join(', ') || null,
      workplace_type: job.Remote_Job ? 'remote' : null,
      employment_type: job.Job_Type || null,
      department: job.Department || job.Industry || null, // Industry when present (per-company field)
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      salary_interval: null,
      description: job.Job_Description || null,
      url: metaData?.list_url
        ? `${metaData.list_url}/${job.id}/${encodeURIComponent((job.Posting_Title || '').replace(/[^a-zA-Z0-9]+/g, '-'))}`
        : `https://${clientname}.zohorecruit.com/jobs/Careers/${job.id}`,
      posted_at: job.Date_Opened || null,
      raw_data: job,
    }));

  // The LIST blob's Job_Description is a TRUNCATED PREVIEW (~150 chars ending in "..."), not the
  // full text — so fetch the detail page whenever the description is missing OR looks like a
  // preview (short, or ellipsis-terminated). Real descriptions are thousands of chars.
  const looksPreview = (d) => !d || d.length < 600 || /\.\.\.|…\s*<?\/?\w*>?\s*$/.test(d.replace(/<[^>]+>/g, '').trim());
  const missingDesc = jobs.filter(j => looksPreview(j.description));
  if (missingDesc.length > 0 && workingDomain) {
    for (let i = 0; i < missingDesc.length; i += DETAIL_BATCH_SIZE) {
      if (i > 0) await new Promise(r => setTimeout(r, 300));
      const batch = missingDesc.slice(i, i + DETAIL_BATCH_SIZE);
      const settled = await Promise.allSettled(
        batch.map(j => {
          const slug = titleSlug(j.raw_data.Posting_Title || j.raw_data.Job_Opening_Name || '');
          return fetchJobDetail(workingDomain, clientname, j.raw_data.id, slug);
        })
      );
      const results = settled.map(r => r.status === 'fulfilled' ? r.value : null);
      results.forEach((desc, idx) => {
        if (desc) batch[idx].description = desc;
      });
    }
  }

  return {
    jobs,
    meta: {
      companyName: metaData?.org_info?.company_name || null,
    },
  };
}

module.exports = { fetchJobs };
