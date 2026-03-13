const { Router } = require('express');
const { companiesRepo, jobsRepo } = require('../../db');

const router = Router();

router.get('/health', async (req, res) => {
  const active = await companiesRepo.findActive();
  const totalJobs = await jobsRepo.countActive();
  res.json({
    status: 'ok',
    companies_tracked: active.length,
    total_active_jobs: totalJobs,
  });
});

module.exports = router;
