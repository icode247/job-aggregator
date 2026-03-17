const { Router } = require('express');
const { companiesRepo, jobsRepo } = require('../../db');
const { getAll } = require('../../utils/metrics');

const router = Router();

router.get('/health', async (req, res) => {
  const [activeCount, totalJobs, metricsData] = await Promise.all([
    companiesRepo.countActive(),
    jobsRepo.countActive(),
    getAll(),
  ]);

  const gauges = metricsData.gauges || {};

  const queueHealth = {
    discovery: {
      waiting: parseInt(gauges['queue.discovery.waiting'] || '0', 10),
      active: parseInt(gauges['queue.discovery.active'] || '0', 10),
      failed: parseInt(gauges['queue.discovery.failed'] || '0', 10),
    },
    sync: {
      waiting: parseInt(gauges['queue.sync.waiting'] || '0', 10),
      active: parseInt(gauges['queue.sync.active'] || '0', 10),
      failed: parseInt(gauges['queue.sync.failed'] || '0', 10),
    },
    crawl: {
      waiting: parseInt(gauges['queue.crawl.waiting'] || '0', 10),
      active: parseInt(gauges['queue.crawl.active'] || '0', 10),
      failed: parseInt(gauges['queue.crawl.failed'] || '0', 10),
    },
  };

  res.json({
    status: 'ok',
    companies_tracked: activeCount,
    total_active_jobs: totalJobs,
    queue_health: queueHealth,
  });
});

module.exports = router;
