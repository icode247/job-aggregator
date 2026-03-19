const { Router } = require('express');
const { jobsRepo } = require('../../db');
const { stripHtml } = require('../../utils/html');

const router = Router();

function formatJob(row) {
  return {
    id: row.id,
    external_id: row.external_id,
    title: row.title,
    department: row.department,
    location: row.location,
    workplace_type: row.workplace_type,
    employment_type: row.employment_type,
    is_remote: row.is_remote || false,
    remote_worldwide: row.remote_worldwide || false,
    visa_sponsorship: row.visa_sponsorship || null,
    experience_level: row.experience_level || null,
    description: row.description ? stripHtml(row.description) : null,
    url: row.url,
    posted_at: row.posted_at,
    ats: row.ats,
    salary: {
      min: row.salary_min,
      max: row.salary_max,
      currency: row.salary_currency,
      interval: row.salary_interval,
    },
    company: {
      id: row.company_id,
      name: row.company_name,
      domain: row.domain,
      ats_slug: row.ats_slug,
      logo_url: row.logo_url,
    },
  };
}

/**
 * GET /api/jobs
 *
 * Query params:
 *   q              - Role / keywords (searches title, department, company name)
 *   work_mode      - any | remote | hybrid | onsite
 *   employment_type - any | full-time | part-time | contract | internship
 *   location       - Free text location filter (e.g. "United States", "Remote", "London")
 *   posted           - 24h | 7d | 30d | 90d | 3m
 *   remote           - true (only fully remote jobs, indexed)
 *   remote_worldwide - true (remote jobs open to any location globally)
 *   visa             - yes | no (H1B/visa sponsorship filter)
 *   experience_level - internship | entry | mid | senior | lead | executive
 *   company_id       - Filter by company ID
 *   ats              - Filter by ATS
 *   limit            - Results per page (default 50, max 200)
 *   page             - Page number (1-based, alternative to offset)
 *   offset           - Pagination offset
 */
router.get('/api/jobs', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const pageParam = parseInt(req.query.page, 10);
  const offset = pageParam > 0 ? (pageParam - 1) * limit : (parseInt(req.query.offset, 10) || 0);

  const filters = { limit, offset };

  if (req.query.q) filters.q = req.query.q;
  if (req.query.work_mode) filters.workMode = req.query.work_mode;
  if (req.query.employment_type) filters.employmentType = req.query.employment_type;
  if (req.query.location) filters.location = req.query.location;
  if (req.query.posted) filters.posted = req.query.posted;
  if (req.query.remote) filters.remote = req.query.remote;
  if (req.query.remote_worldwide) filters.remoteWorldwide = req.query.remote_worldwide;
  if (req.query.visa) filters.visa = req.query.visa;
  if (req.query.experience_level) filters.experienceLevel = req.query.experience_level;
  if (req.query.company_id) filters.companyId = parseInt(req.query.company_id, 10);
  if (req.query.ats) filters.ats = req.query.ats;

  const [jobs, total] = await Promise.all([
    jobsRepo.findActive(filters),
    jobsRepo.countActive(filters),
  ]);

  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);
  const hasNext = offset + limit < total;
  const hasPrev = offset > 0;

  res.json({
    meta: {
      total,
      limit,
      offset,
      page,
      totalPages,
      hasNext,
      hasPrev,
      nextOffset: hasNext ? offset + limit : null,
      prevOffset: hasPrev ? Math.max(0, offset - limit) : null,
    },
    data: jobs.map(formatJob),
  });
});

router.get('/api/jobs/:id', async (req, res) => {
  const job = await jobsRepo.findById(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const formatted = formatJob(job);
  formatted.description_html = job.description;
  res.json({ data: formatted });
});

module.exports = router;
