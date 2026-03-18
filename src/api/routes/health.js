const { Router } = require('express');
const { companiesRepo, jobsRepo } = require('../../db');
const { Queue } = require('bullmq');
const { createRedisConnection } = require('../../queues/connection');

const router = Router();

// Lazy-init read-only queue instances for health checks
let queues;
function getQueues() {
  if (!queues) {
    queues = {
      discovery: new Queue('discovery', { connection: createRedisConnection() }),
      sync: new Queue('sync', { connection: createRedisConnection() }),
      crawl: new Queue('crawl', { connection: createRedisConnection() }),
    };
  }
  return queues;
}

async function getQueueCounts(queue) {
  try {
    const counts = await queue.getJobCounts('waiting', 'active', 'failed', 'delayed');
    return counts;
  } catch {
    return { waiting: 0, active: 0, failed: 0, delayed: 0 };
  }
}

router.get('/health', async (req, res) => {
  const q = getQueues();

  const [activeCount, totalJobs, discovery, sync, crawl] = await Promise.all([
    companiesRepo.countActive(),
    jobsRepo.countActive(),
    getQueueCounts(q.discovery),
    getQueueCounts(q.sync),
    getQueueCounts(q.crawl),
  ]);

  res.json({
    status: 'ok',
    companies_tracked: activeCount,
    total_active_jobs: totalJobs,
    queue_health: {
      discovery: { waiting: discovery.waiting, active: discovery.active, failed: discovery.failed, delayed: discovery.delayed },
      sync: { waiting: sync.waiting, active: sync.active, failed: sync.failed, delayed: sync.delayed },
      crawl: { waiting: crawl.waiting, active: crawl.active, failed: crawl.failed, delayed: crawl.delayed },
    },
  });
});

module.exports = router;
