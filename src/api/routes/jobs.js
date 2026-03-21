const { Router } = require('express');
const { jobsRepo } = require('../../db');
const { query } = require('../../db/connection');
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
  if (req.query.ats) filters.ats = req.query.ats.split(',');

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

/**
 * GET /api/stats
 * Global stats for landing pages and SEO
 */
router.get('/api/stats', async (req, res) => {
  const { rows } = await query(
    `SELECT
      COUNT(*) as total_jobs,
      COUNT(*) FILTER (WHERE is_remote = true) as remote_jobs,
      COUNT(*) FILTER (WHERE visa_sponsorship = 'yes') as visa_sponsorship_jobs,
      COUNT(DISTINCT company_id) as companies,
      COUNT(DISTINCT ats) as platforms
    FROM jobs WHERE removed_at IS NULL`
  );
  res.json({ data: rows[0] });
});

/**
 * GET /api/companies
 * Company directory with job counts
 * Query params: q, ats, limit, page
 */
router.get('/api/companies', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const page = parseInt(req.query.page, 10) || 1;
  const offset = (page - 1) * limit;

  const clauses = ['j.removed_at IS NULL'];
  const params = [];

  if (req.query.q) {
    clauses.push('c.company_name ILIKE ?');
    params.push(`%${req.query.q}%`);
  }
  if (req.query.ats) {
    clauses.push('c.ats = ?');
    params.push(req.query.ats);
  }

  const where = clauses.join(' AND ');

  const [{ rows }, { rows: countRows }] = await Promise.all([
    query(
      `SELECT c.id, c.company_name as name, c.domain, c.logo_url, c.ats,
        COUNT(j.id) as job_count,
        COUNT(j.id) FILTER (WHERE j.is_remote = true) as remote_job_count,
        COUNT(j.id) FILTER (WHERE j.visa_sponsorship = 'yes') as visa_job_count
      FROM companies c JOIN jobs j ON j.company_id = c.id
      WHERE ${where}
      GROUP BY c.id, c.company_name, c.domain, c.logo_url, c.ats
      ORDER BY job_count DESC
      LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    ),
    query(
      `SELECT COUNT(DISTINCT c.id) as count
      FROM companies c JOIN jobs j ON j.company_id = c.id
      WHERE ${where}`,
      params
    ),
  ]);

  const total = parseInt(countRows[0].count, 10);
  res.json({
    meta: { total, limit, page, totalPages: Math.ceil(total / limit) },
    data: rows,
  });
});

/**
 * GET /api/companies/:id
 * Single company profile with stats
 */
router.get('/api/companies/:id', async (req, res) => {
  const { rows } = await query(
    `SELECT c.id, c.company_name, c.domain, c.logo_url, c.ats, c.career_url,
      COUNT(j.id) as job_count,
      COUNT(j.id) FILTER (WHERE j.is_remote = true) as remote_job_count,
      COUNT(j.id) FILTER (WHERE j.visa_sponsorship = 'yes') as visa_job_count
    FROM companies c LEFT JOIN jobs j ON j.company_id = c.id AND j.removed_at IS NULL
    WHERE c.id = ?
    GROUP BY c.id`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Company not found' });
  res.json({ data: rows[0] });
});

/**
 * GET /api/locations
 * Top locations with job counts for location pages
 * Query params: q, limit
 */
router.get('/api/locations', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const params = [];
  let where = 'removed_at IS NULL AND location IS NOT NULL';

  if (req.query.q) {
    where += ' AND location ILIKE ?';
    params.push(`%${req.query.q}%`);
  }

  const { rows } = await query(
    `SELECT location, COUNT(*) as job_count
    FROM jobs WHERE ${where}
    GROUP BY location ORDER BY job_count DESC
    LIMIT ?`,
    [...params, limit]
  );
  res.json({ data: rows });
});

/**
 * GET /api/roles
 * Top role categories with job counts for role pages
 * Cached for 1 hour since it scans all jobs
 */
let rolesCache = null;
let rolesCacheExpiry = 0;

router.get('/api/roles', async (req, res) => {
  if (rolesCache && Date.now() < rolesCacheExpiry) {
    return res.json({ data: rolesCache });
  }

  const { rows } = await query(
    `SELECT
      CASE
        WHEN title ILIKE '%software engineer%' OR title ILIKE '%software developer%' THEN 'Software Engineer'
        WHEN title ILIKE '%frontend%' OR title ILIKE '%front-end%' OR title ILIKE '%front end%' THEN 'Frontend Developer'
        WHEN title ILIKE '%backend%' OR title ILIKE '%back-end%' OR title ILIKE '%back end%' THEN 'Backend Developer'
        WHEN title ILIKE '%full stack%' OR title ILIKE '%fullstack%' THEN 'Fullstack Developer'
        WHEN title ILIKE '%data scientist%' THEN 'Data Scientist'
        WHEN title ILIKE '%data analyst%' THEN 'Data Analyst'
        WHEN title ILIKE '%data engineer%' THEN 'Data Engineer'
        WHEN title ILIKE '%machine learning%' OR title ILIKE '%ML engineer%' OR title ILIKE '%AI engineer%' THEN 'ML / AI Engineer'
        WHEN title ILIKE '%product manager%' THEN 'Product Manager'
        WHEN title ILIKE '%project manager%' THEN 'Project Manager'
        WHEN title ILIKE '%product designer%' OR title ILIKE '%UX designer%' OR title ILIKE '%UI designer%' THEN 'Product Designer'
        WHEN title ILIKE '%devops%' OR title ILIKE '%site reliability%' OR title ILIKE '%SRE%' THEN 'DevOps / SRE'
        WHEN title ILIKE '%QA%' OR title ILIKE '%quality assurance%' OR title ILIKE '%test engineer%' THEN 'QA Engineer'
        WHEN title ILIKE '%mobile%' OR title ILIKE '%iOS%' OR title ILIKE '%android%' THEN 'Mobile Developer'
        WHEN title ILIKE '%marketing%' THEN 'Marketing'
        WHEN title ILIKE '%sales%' OR title ILIKE '%account executive%' OR title ILIKE '%business development%' THEN 'Sales'
        WHEN title ILIKE '%customer success%' OR title ILIKE '%customer support%' THEN 'Customer Support'
        WHEN title ILIKE '%security%' OR title ILIKE '%cybersecurity%' THEN 'Security Engineer'
        WHEN title ILIKE '%cloud%' OR title ILIKE '%infrastructure%' THEN 'Cloud / Infrastructure'
        WHEN title ILIKE '%technical writer%' OR title ILIKE '%content writer%' THEN 'Technical Writer'
        WHEN title ILIKE '%recruiter%' OR title ILIKE '%talent%' THEN 'Recruiter'
        WHEN title ILIKE '%finance%' OR title ILIKE '%accountant%' OR title ILIKE '%financial%' THEN 'Finance'
        WHEN title ILIKE '%human resources%' OR title ILIKE '%HR %' THEN 'Human Resources'
        ELSE 'Other'
      END as role,
      COUNT(*) as job_count,
      COUNT(*) FILTER (WHERE is_remote = true) as remote_count,
      COUNT(*) FILTER (WHERE visa_sponsorship = 'yes') as visa_count
    FROM jobs WHERE removed_at IS NULL
    GROUP BY role ORDER BY job_count DESC`
  );
  rolesCache = rows;
  rolesCacheExpiry = Date.now() + 60 * 60 * 1000; // 1 hour
  res.json({ data: rows });
});

/**
 * GET /api/facets
 * Aggregated counts for filter sidebar (employment types, experience levels, ATS platforms)
 */
router.get('/api/facets', async (req, res) => {
  const [empTypes, expLevels, atsPlatforms, workModes] = await Promise.all([
    query(`SELECT employment_type, COUNT(*) as count FROM jobs
      WHERE removed_at IS NULL AND employment_type IS NOT NULL
      GROUP BY employment_type ORDER BY count DESC`),
    query(`SELECT experience_level, COUNT(*) as count FROM jobs
      WHERE removed_at IS NULL AND experience_level IS NOT NULL
      GROUP BY experience_level ORDER BY count DESC`),
    query(`SELECT ats, COUNT(*) as count FROM jobs
      WHERE removed_at IS NULL
      GROUP BY ats ORDER BY count DESC`),
    query(`SELECT workplace_type, COUNT(*) as count FROM jobs
      WHERE removed_at IS NULL AND workplace_type IS NOT NULL
      GROUP BY workplace_type ORDER BY count DESC`),
  ]);
  res.json({
    data: {
      employment_types: empTypes.rows,
      experience_levels: expLevels.rows,
      ats_platforms: atsPlatforms.rows,
      work_modes: workModes.rows,
    },
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
