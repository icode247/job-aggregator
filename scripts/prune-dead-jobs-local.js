/**
 * Local half of the dead-job-pruning split: verifies the ODD-id partition of
 * the eligible job population. Render's worker.js owns the EVEN-id half (see
 * pruneDeadJobs's partitionMod/partitionRemainder in src/tasks/dead-job-check.js).
 * Same HTTP-verified pruneDeadJobs() already running in production — this is a
 * second independent runner on a separate network/IP, spreading outbound
 * verification traffic across two sources and roughly doubling total throughput
 * without either side risking re-checking the other's rows.
 *
 * A job is only ever marked removed on an HTTP-confirmed 404/410 or an explicit
 * dead-page phrase (checkUrl in dead-job-check.js) — never on a guess.
 *
 * LOOP=1 keeps running batches on an interval (matches the backfill-comeet-desc.js
 * / backfill-desc-generic.js convention already used by the local crawler fleet);
 * without it, runs one batch and exits — wrap in `while true` for crash-restart,
 * same as the other local crawlers in scripts/launch-local-crawlers.sh.
 *
 * Usage: DATABASE_URL=... NODE_ENV=production node scripts/prune-dead-jobs-local.js
 *   Env: LOOP=1 INTERVAL_S=1200 LIMIT=500 CONCURRENCY=10 TAIL_DAYS=30 RECHECK_DAYS=14 PG_POOL_MAX=1
 */
const { pruneDeadJobs } = require('../src/tasks/dead-job-check');
const { closeDb } = require('../src/db/connection');

const LOOP = process.env.LOOP === '1';
const INTERVAL_S = parseInt(process.env.INTERVAL_S, 10) || 1200;
const LIMIT = parseInt(process.env.LIMIT, 10) || 500;
const CONCURRENCY = parseInt(process.env.CONCURRENCY, 10) || 10;
const TAIL_DAYS = parseInt(process.env.TAIL_DAYS, 10) || 30;
const RECHECK_DAYS = parseInt(process.env.RECHECK_DAYS, 10) || 14;

async function runOnce() {
  const { checked, dead, uncertain } = await pruneDeadJobs({
    limit: LIMIT, concurrency: CONCURRENCY, tailDays: TAIL_DAYS, recheckDays: RECHECK_DAYS,
    partitionMod: 2, partitionRemainder: 1,
  });
  console.log(`[${new Date().toISOString()}] checked=${checked} dead=${dead} uncertain=${uncertain}`);
}

async function main() {
  if (!LOOP) {
    await runOnce();
    await closeDb();
    return;
  }
  for (;;) {
    try {
      await runOnce();
    } catch (err) {
      console.error(`[${new Date().toISOString()}] error: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_S * 1000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
