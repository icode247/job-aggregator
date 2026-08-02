const logger = require('../logger');

// Pinpoint workplace_type values -> our vocabulary
function normalizeWorkplace(v) {
  const s = String(v || '').toLowerCase();
  if (!s) return null;
  if (s.includes('remote')) return 'remote';
  if (s.includes('hybrid')) return 'hybrid';
  if (s.includes('site') || s.includes('office')) return 'onsite';
  return null;
}

function buildPinpointDescription(job) {
  const sections = [];
  if (job.description) sections.push(job.description);
  if (job.key_responsibilities) {
    const header = job.key_responsibilities_header || 'Key Responsibilities';
    sections.push(`<h3>${header}</h3>${job.key_responsibilities}`);
  }
  if (job.skills_knowledge_expertise) {
    const header = job.skills_knowledge_expertise_header || 'Skills, Knowledge and Expertise';
    sections.push(`<h3>${header}</h3>${job.skills_knowledge_expertise}`);
  }
  if (job.benefits) {
    const header = job.benefits_header || 'Benefits';
    sections.push(`<h3>${header}</h3>${job.benefits}`);
  }
  return sections.length > 0 ? sections.join('\n') : null;
}

async function fetchJobs(clientname) {
  const res = await fetch(
    `https://${encodeURIComponent(clientname)}.pinpointhq.com/postings.json`,
    { signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error(`Pinpoint HTTP ${res.status}`);
  const data = await res.json();
  const listings = data.data || data.postings || data || [];
  const jobsArray = Array.isArray(listings) ? listings : [];

  const jobs = jobsArray.map(job => ({
    external_id: `pinpoint_${job.id}`,
    title: job.title || job.attributes?.title,
    department: job.department?.name || job.attributes?.department || null,
    location: job.location?.name || job.attributes?.location || null,
    // Source exposes workplace_type directly (remote|hybrid|on_site) — job.remote didn't exist.
    workplace_type: normalizeWorkplace(job.workplace_type) || (job.remote ? 'remote' : null),
    employment_type: job.employment_type_text || job.employment_type || job.attributes?.employment_type || null,
    // Structured compensation was being dropped.
    salary_min: job.compensation_minimum || null,
    salary_max: job.compensation_maximum || null,
    salary_currency: job.compensation_currency || null,
    salary_interval: job.compensation_frequency || null,
    description: buildPinpointDescription(job),
    url: job.url || `https://${clientname}.pinpointhq.com/postings/${job.id}`,
    posted_at: job.published_at || job.created_at || null,
    raw_data: job,
  }));

  return { jobs, meta: { companyName: null } };
}

module.exports = { fetchJobs };
