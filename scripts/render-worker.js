#!/usr/bin/env node
/**
 * Render background-worker entrypoint — the always-on replacement for the Heroku worker
 * ($50 Standard-2X  ->  $7 Render Starter). NO Redis / BullMQ.
 *
 * It covers exactly the gap the local Mac fleet does NOT: the four "sync-only" platforms
 * (workday, icims, oracle, successfactors), plus the worker's maintenance loops. The Macs
 * still crawl the other 9 platforms + the workable marketplace, so between this box and the
 * Macs, everything the Heroku worker did is covered — and the worker can be scaled to 0.
 *
 *   crawl    — forks scripts/crawl-companies-local.js (ATS=the 4), the SAME claim-and-crawl
 *              (FOR UPDATE SKIP LOCKED) loop the Macs use; auto-restarts if it exits.
 *   maintain — description + classification backfill, dead-job pruning, 90-day stale cleanup
 *              (copied verbatim from src/worker.js).
 *
 * Render config:  Build `npm ci`  ·  Start `node scripts/render-worker.js`  ·  env DATABASE_URL
 * Tune for the 512MB/low-CPU Starter via env: CRAWL_ATS, CONCURRENCY, BATCH, PG_POOL_MAX.
 */
// Keep demand-crawl's per-cycle memory small on the 512MB box (it shares the parent process
// with the maintenance loops). MUST be set before requiring demand-crawl, which reads these
// at module load. Smaller page/batch => fewer job objects in flight => no parent-heap OOM.
process.env.DEMAND_BATCH = process.env.DEMAND_BATCH || '12';
process.env.DEMAND_PAGE_SIZE = process.env.DEMAND_PAGE_SIZE || '40';
process.env.DEMAND_MAX_TITLES = process.env.DEMAND_MAX_TITLES || '2';
process.env.DEMAND_MAX_LOCATIONS = process.env.DEMAND_MAX_LOCATIONS || '2';
const { fork } = require('child_process');
const path = require('path');
const logger = require('../src/logger');
const { backfillForAts, ATS_CONFIG } = require('../src/tasks/backfill-descriptions');
const { backfillClassifications } = require('../src/tasks/backfill-classifications');
const { pruneDeadJobs } = require('../src/tasks/dead-job-check');
const { cycle: runDemandCycle, ensureColumns: ensureDemandColumns } = require('../src/tasks/demand-crawl');
const { query, closeDb } = require('../src/db/connection');

const CRAWL_ATS = process.env.CRAWL_ATS || 'workday,icims,oracle,successfactors';

// --- crawl loop: fork the tested local crawler for the 4 sync-only platforms ---
let child = null;
let shuttingDown = false;
function startCrawler() {
  if (shuttingDown) return;
  child = fork(path.join(__dirname, 'crawl-companies-local.js'), [], {
    // Cap the child heap below the ~258MB Node auto-picks on the 512MB Starter so a runaway
    // tenant fails with a clean V8 error + restart rather than a container SIGKILL. The REAL
    // fix is low concurrency/batch: the OOM was 4-way concurrency crawling 500-600-posting
    // Workday tenants (each posting carries full description HTML) — several 10MB job arrays
    // in flight at once. CONCURRENCY 2 + BATCH 8 keeps at most ~2 tenants' jobs resident and
    // GCs between companies. Override via Render env if you later move to a bigger instance.
    execArgv: ['--max-old-space-size=224'],
    env: {
      ...process.env,
      ATS: CRAWL_ATS,
      CONCURRENCY: process.env.CONCURRENCY || '2',
      BATCH: process.env.BATCH || '8',
      PG_POOL_MAX: process.env.PG_POOL_MAX || '2',
      DELAY_MS: process.env.DELAY_MS || '300',
      PROXY_DISABLED: '1', // all four crawl direct; never route through the metered proxy
    },
  });
  child.on('exit', (code, sig) => {
    child = null;
    if (shuttingDown) return;
    logger.warn({ code, sig }, 'crawler child exited — restarting in 5s');
    setTimeout(startCrawler, 5000);
  });
}

// --- maintenance loops (verbatim cadences from src/worker.js) ---
let descRunning = false;
async function runDescBackfill() {
  if (!descRunning) {
    descRunning = true;
    try {
      // Sequential per-platform (NOT the all-parallel backfillDescriptions) so the parent
      // process's memory stays bounded on the 512MB Starter: one platform's batch of HTML
      // descriptions in flight at a time, not ~15 platforms' worth at once. Batch/concurrency
      // capped for the same reason. Slower per cycle, but it loops every 5m and re-drains.
      let filled = 0;
      for (const [ats, cfg] of Object.entries(ATS_CONFIG)) {
        try {
          const r = await backfillForAts(ats, Math.min(cfg.batchSize, 40), Math.min(cfg.concurrency, 3));
          filled += r.filled;
        } catch (e) { logger.warn({ ats, err: e.message }, 'desc backfill (ats) error'); }
      }
      logger.info({ filled }, 'desc backfill cycle complete');
    } catch (e) { logger.error({ err: e.message }, 'desc backfill error'); }
    finally { descRunning = false; }
  }
  setTimeout(runDescBackfill, 5 * 60 * 1000);
}
async function runClassify() {
  try { await backfillClassifications(); } catch (e) { logger.error({ err: e.message }, 'classification backfill error'); }
  setTimeout(runClassify, 60 * 1000);
}
async function runStaleCleanup() {
  try {
    const { rows } = await query("DELETE FROM jobs WHERE posted_at IS NOT NULL AND posted_at < NOW() - INTERVAL '90 days' RETURNING id");
    if (rows.length) {
      logger.info({ deleted: rows.length }, 'stale job cleanup');
      // Hard DELETEs leave no row for the outbox trigger to mark, so without this the index
      // would keep serving jobs that no longer exist. Fire and forget — never fail the cleanup.
      require('../src/tasks/meili-sync').removeFromIndex(rows.map((r) => r.id)).catch(() => {});
    }
  } catch (e) { logger.error({ err: e.message }, 'stale job cleanup error'); }
  setTimeout(runStaleCleanup, 6 * 60 * 60 * 1000);
}
async function runDeadPrune() {
  try { const r = await pruneDeadJobs({ limit: 400, concurrency: 10, tailDays: 30, recheckDays: 14 }); if (r.checked) logger.info(r, 'dead-job pruning'); }
  catch (e) { logger.error({ err: e.message }, 'dead-job pruning error'); }
  setTimeout(runDeadPrune, 60 * 60 * 1000);
}
// Demand-driven crawl (Phase 2): moved off the Mac to the cloud so home-network outages don't
// pause it. Runs IN this parent process (not a fork) — it's I/O-bound + low-memory (one API
// page at a time), cheaper than a second Node runtime on the 512MB box. Sources activate by
// env: LiftMyCV + jobhose need no key; Wonsulting needs WONSULTING_COOKIE; googledork a paid
// SERPER_API_KEY. A single crawl guard prevents overlap.
let demandRunning = false;
// Ship changed jobs into the search index. Driven by the index_dirty_at outbox column, so it
// picks up writes from every source — this worker, the local crawler fleet, and the one-off
// scripts. No-ops entirely when MEILI_HOST is unset.
let meiliSyncRunning = false;
async function runMeiliSync() {
  if (meiliSyncRunning) return;
  meiliSyncRunning = true;
  try {
    const { syncMeili } = require('../src/tasks/meili-sync');
    await syncMeili();
  } catch (e) {
    logger.error({ err: e.message }, 'meili sync');
  } finally {
    meiliSyncRunning = false;
    setTimeout(runMeiliSync, 60 * 1000);
  }
}

async function runDemandCrawl() {
  if (!demandRunning) {
    demandRunning = true;
    try { await runDemandCycle(); } catch (e) { logger.error({ err: e.message }, 'demand-crawl cycle error'); }
    finally { demandRunning = false; }
  }
  setTimeout(runDemandCrawl, 20 * 60 * 1000);
}

function shutdown(sig) {
  shuttingDown = true;
  logger.info({ sig }, 'render-worker shutting down');
  if (child) child.kill('SIGTERM');
  const force = setTimeout(() => process.exit(0), 12000);
  force.unref();
  closeDb().finally(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err: err?.message }, 'unhandledRejection in render-worker'));

logger.info({ crawlAts: CRAWL_ATS }, 'render-worker starting — crawl 4 sync-only platforms + maintenance + demand-crawl (no Redis)');
startCrawler();
setTimeout(runDescBackfill, 5 * 60 * 1000);
setTimeout(runClassify, 2 * 60 * 1000);
setTimeout(runStaleCleanup, 5 * 60 * 1000);
setTimeout(runDeadPrune, 8 * 60 * 1000);
setTimeout(runMeiliSync, 90 * 1000);
// demand-crawl: ensure its columns exist, then start the loop a bit after boot.
ensureDemandColumns().catch((e) => logger.warn({ err: e.message }, 'demand ensureColumns')).finally(() => setTimeout(runDemandCrawl, 6 * 60 * 1000));
