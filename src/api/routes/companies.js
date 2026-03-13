const { Router } = require('express');
const { companiesRepo } = require('../../db');

const router = Router();

router.get('/api/companies', (req, res) => {
  const companies = companiesRepo.findAll();
  res.json({
    meta: { total: companies.length },
    data: companies,
  });
});

router.get('/api/companies/:id', (req, res) => {
  const company = companiesRepo.findById(req.params.id);
  if (!company) return res.status(404).json({ error: 'Company not found' });
  res.json({ data: company });
});

module.exports = router;
