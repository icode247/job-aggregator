/**
 * Paylocity ATS adapter.
 * API docs: https://recruiting.paylocity.com/Recruiting/v2/api/feed/documentation
 *
 * ats_slug format: "{GUID}" (company-specific, found in careers page URL)
 * career_url format: "https://recruiting.paylocity.com/recruiting/jobs/All/{GUID}"
 *
 * The feed endpoint returns full job details including description.
 */
const logger = require('../logger');

const BASE_URL = 'https://recruiting.paylocity.com/recruiting/v2/api/feed/jobs';

function parseSalary(salaryDesc) {
  if (!salaryDesc) return {};
  // Try to extract salary range like "$80,000 - $120,000" or "$50/hr - $70/hr"
  const match = salaryDesc.match(/\$?([\d,]+(?:\.\d+)?)\s*[-–to]+\s*\$?([\d,]+(?:\.\d+)?)/i);
  if (!match) return {};

  const min = parseFloat(match[1].replace(/,/g, ''));
  const max = parseFloat(match[2].replace(/,/g, ''));
  if (isNaN(min) || isNaN(max)) return {};

  let interval = 'yearly';
  const lower = salaryDesc.toLowerCase();
  if (lower.includes('/hr') || lower.includes('hour') || lower.includes('hourly')) interval = 'hourly';
  else if (lower.includes('/mo') || lower.includes('month')) interval = 'monthly';
  else if (lower.includes('/wk') || lower.includes('week')) interval = 'weekly';

  // Detect currency — default USD
  let currency = 'USD';
  if (lower.includes('€') || lower.includes('eur')) currency = 'EUR';
  else if (lower.includes('£') || lower.includes('gbp')) currency = 'GBP';
  else if (lower.includes('cad') || lower.includes('c$')) currency = 'CAD';

  return { salary_min: min, salary_max: max, salary_currency: currency, salary_interval: interval };
}

function mapEmploymentType(jobTypes) {
  if (!jobTypes) return null;
  const lower = (Array.isArray(jobTypes) ? jobTypes.join(' ') : jobTypes).toLowerCase();
  if (lower.includes('full')) return 'Full-time';
  if (lower.includes('part')) return 'Part-time';
  if (lower.includes('contract') || lower.includes('temp')) return 'Contract';
  if (lower.includes('intern')) return 'Internship';
  return jobTypes;
}

function mapLocation(jobLocation) {
  if (!jobLocation) return null;
  if (typeof jobLocation === 'string') return jobLocation;
  const parts = [jobLocation.name, jobLocation.city, jobLocation.state].filter(Boolean);
  return parts.join(', ') || null;
}

async function fetchJobs(atsSlug) {
  const url = `${BASE_URL}/${encodeURIComponent(atsSlug)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });

  if (!res.ok) {
    throw new Error(`Paylocity HTTP ${res.status}`);
  }

  const data = await res.json();
  const rawJobs = data.jobs || data;

  if (!Array.isArray(rawJobs)) {
    logger.warn({ atsSlug }, 'Paylocity: unexpected response format');
    return { jobs: [], meta: {} };
  }

  let companyName = null;

  const jobs = rawJobs.map(job => {
    if (!companyName && job.companyName) companyName = job.companyName;

    // Combine description and requirements
    const descParts = [job.description, job.requirements].filter(Boolean);
    const description = descParts.length > 0 ? descParts.join('\n') : null;

    const salary = parseSalary(job.salaryDescription);

    return {
      external_id: `paylocity_${job.jobId}`,
      title: job.title || 'Untitled',
      department: job.hiringDepartment || null,
      location: mapLocation(job.jobLocation) || null,
      workplace_type: null, // Paylocity doesn't provide this directly
      employment_type: mapEmploymentType(job.jobTypesArray || job.jobTypes) || null,
      salary_min: salary.salary_min || null,
      salary_max: salary.salary_max || null,
      salary_currency: salary.salary_currency || null,
      salary_interval: salary.salary_interval || null,
      description,
      url: job.applyUrl || job.displayUrl || `https://recruiting.paylocity.com/recruiting/jobs/Details/${atsSlug}/${job.jobId}`,
      posted_at: job.publishedDate || job.createdUtc || null,
      raw_data: job,
    };
  });

  return {
    jobs,
    meta: {
      companyName,
    },
  };
}

module.exports = { fetchJobs };
