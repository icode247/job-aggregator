const logger = require('../logger');

async function fetchJobs(clientname) {
  const res = await fetch(
    `https://jobs.jobvite.com/api/v2/job?companyId=${encodeURIComponent(clientname)}`,
    { signal: AbortSignal.timeout(15000) }
  );

  // Fallback: try page-based endpoint
  if (!res.ok) {
    const htmlRes = await fetch(
      `https://jobs.jobvite.com/${encodeURIComponent(clientname)}/search?nl=1`,
      { signal: AbortSignal.timeout(15000) }
    );
    if (!htmlRes.ok) throw new Error(`Jobvite HTTP ${htmlRes.status}`);
    const html = await htmlRes.text();

    // Extract jobs from JSON embedded in page
    const jsonMatch = html.match(/var\s+jvData\s*=\s*(\{[\s\S]*?\});/);
    if (!jsonMatch) throw new Error('Jobvite: could not parse job data');
    const data = JSON.parse(jsonMatch[1]);
    const listings = data.requisitions || [];

    return {
      jobs: listings.map(job => ({
        external_id: `jobvite_${job.eId}`,
        title: job.title,
        department: job.category || null,
        location: job.location || null,
        workplace_type: null,
        employment_type: job.type || null,
        salary_min: null, salary_max: null, salary_currency: null, salary_interval: null,
        description: job.briefDescription || job.description || null,
        url: job.detailUrl || `https://jobs.jobvite.com/${clientname}/job/${job.eId}`,
        posted_at: job.date || null,
        raw_data: job,
      })),
      meta: { companyName: data.companyName || null },
    };
  }

  const data = await res.json();
  const listings = data.requisitions || [];

  return {
    jobs: listings.map(job => ({
      external_id: `jobvite_${job.eId || job.id}`,
      title: job.title,
      department: job.category || null,
      location: job.location || null,
      workplace_type: null,
      employment_type: job.type || null,
      salary_min: null, salary_max: null, salary_currency: null, salary_interval: null,
      description: job.briefDescription || job.description || null,
      url: job.detailUrl || `https://jobs.jobvite.com/${clientname}/job/${job.eId || job.id}`,
      posted_at: job.date || null,
      raw_data: job,
    })),
    meta: { companyName: null },
  };
}

module.exports = { fetchJobs };
