/**
 * Build full description from Lever's split fields:
 * - descriptionPlain/description: intro/overview
 * - lists[]: sections like Responsibilities, Requirements, etc.
 * - additionalPlain/additional: extra info (compensation, benefits, etc.)
 */
function buildFullDescription(job) {
  const parts = [];

  // Main description
  if (job.descriptionPlain) parts.push(job.descriptionPlain);
  else if (job.description) parts.push(job.description);

  // Lists (Responsibilities, Requirements, Qualifications, etc.)
  for (const list of (job.lists || [])) {
    if (list.text && list.content) {
      parts.push(`${list.text}:\n${list.content}`);
    }
  }

  // Additional info (compensation, EEO, benefits)
  if (job.additionalPlain) parts.push(job.additionalPlain);
  else if (job.additional) parts.push(job.additional);

  return parts.length > 0 ? parts.join('\n\n') : null;
}

async function fetchJobs(clientname) {
  const res = await fetch(`https://api.lever.co/v0/postings/${encodeURIComponent(clientname)}`);
  if (!res.ok) throw new Error(`Lever HTTP ${res.status}`);
  const data = await res.json();
  const jobs = (Array.isArray(data) ? data : []).map(job => {
    const salary = job.salaryRange || {};
    return {
      external_id: `lever_${job.id}`,
      title: job.text,
      department: job.categories?.team || job.categories?.department || null,
      location: job.categories?.location || 'Remote',
      workplace_type: job.workplaceType || null,
      employment_type: job.categories?.commitment || null,
      salary_min: salary.min || null,
      salary_max: salary.max || null,
      salary_currency: salary.currency || null,
      salary_interval: salary.interval || null,
      description: buildFullDescription(job),
      url: job.hostedUrl,
      posted_at: job.createdAt ? new Date(job.createdAt).toISOString() : null,
      raw_data: job,
    };
  });

  return {
    jobs,
    meta: {
      companyName: null,
      logoUrl: null,
    },
  };
}

module.exports = { fetchJobs };
