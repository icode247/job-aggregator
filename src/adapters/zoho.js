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

async function fetchJobs(clientname) {
  let html = null;

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
      department: job.Department || null,
      location: [job.City, job.State, job.Country1].filter(Boolean).join(', ') || null,
      workplace_type: job.Remote_Job ? 'remote' : null,
      employment_type: job.Job_Type || null,
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

  return {
    jobs,
    meta: {
      companyName: metaData?.org_info?.company_name || null,
    },
  };
}

module.exports = { fetchJobs };
