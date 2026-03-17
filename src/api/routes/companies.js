const { Router } = require('express');
const { companiesRepo } = require('../../db');

const router = Router();

router.get('/api/companies', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const pageParam = parseInt(req.query.page, 10);
  const offset = pageParam > 0 ? (pageParam - 1) * limit : (parseInt(req.query.offset, 10) || 0);

  const [companies, total] = await Promise.all([
    companiesRepo.findAllPaginated(limit, offset),
    companiesRepo.countAll(),
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
    data: companies,
  });
});

router.get('/api/companies/:id', async (req, res) => {
  const company = await companiesRepo.findById(req.params.id);
  if (!company) return res.status(404).json({ error: 'Company not found' });
  res.json({ data: company });
});

module.exports = router;
