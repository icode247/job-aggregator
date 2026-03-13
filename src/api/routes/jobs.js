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

router.get('/api/jobs', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = parseInt(req.query.offset, 10) || 0;
  const filters = {};

  if (req.query.company_id) filters.companyId = parseInt(req.query.company_id, 10);
  if (req.query.ats) filters.ats = req.query.ats;

  const jobs = await jobsRepo.findActive({ ...filters, limit, offset });
  const total = await jobsRepo.countActive(filters);

  res.json({
    meta: { total, limit, offset },
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
