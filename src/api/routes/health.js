const { Router } = require('express');
const { companiesRepo, jobsRepo } = require('../../db');
const { Queue } = require('bullmq');
const { createRedisConnection } = require('../../queues/connection');

const router = Router();

// Lazy-init read-only queue instance for health checks. When REDIS_URL is unset the
// BullMQ queue/Redis has been retired — skip it entirely (a live getJobCounts against a
// dead Redis would hang forever, since maxRetriesPerRequest is null, and hang /health).
let queues;
function getQueues() {
  if (!process.env.REDIS_URL) return { sync: null };
  if (!queues) {
    queues = {
      sync: new Queue('sync', { connection: createRedisConnection() }),
    };
  }
  return queues;
}

async function getQueueCounts(queue) {
  if (!queue) return null;
  try {
    const counts = await queue.getJobCounts('waiting', 'active', 'failed', 'delayed');
    return counts;
  } catch {
    return { waiting: 0, active: 0, failed: 0, delayed: 0 };
  }
}

router.get('/health', async (req, res) => {
  const q = getQueues();

  const [activeCount, totalJobs, sync] = await Promise.all([
    companiesRepo.countActive(),
    jobsRepo.countActive(),
    getQueueCounts(q.sync),
  ]);

  res.json({
    status: 'ok',
    companies_tracked: activeCount,
    total_active_jobs: totalJobs,
    queue_health: sync
      ? { sync: { waiting: sync.waiting, active: sync.active, failed: sync.failed, delayed: sync.delayed } }
      : { sync: 'disabled (redis retired)' },
  });
});

module.exports = router;
