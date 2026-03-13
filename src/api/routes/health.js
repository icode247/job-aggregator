const { Router } = require('express');
const { companiesRepo, jobsRepo } = require('../../db');

const router = Router();

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    companies_tracked: companiesRepo.findActive().length,
    total_active_jobs: jobsRepo.countActive(),
  });
});

module.exports = router;
