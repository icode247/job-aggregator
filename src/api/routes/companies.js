const { Router } = require('express');
const { companiesRepo } = require('../../db');

const router = Router();

router.get('/api/companies', async (req, res) => {
  const companies = await companiesRepo.findAll();
  res.json({
    meta: { total: companies.length },
    data: companies,
  });
});

router.get('/api/companies/:id', async (req, res) => {
  const company = await companiesRepo.findById(req.params.id);
  if (!company) return res.status(404).json({ error: 'Company not found' });
  res.json({ data: company });
});

module.exports = router;
