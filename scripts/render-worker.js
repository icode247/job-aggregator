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
const { fork } = require('child_process');
const path = require('path');
const logger = require('../src/logger');
const { backfillDescriptions } = require('../src/tasks/backfill-descriptions');
const { backfillClassifications } = require('../src/tasks/backfill-classifications');
const { pruneDeadJobs } = require('../src/tasks/dead-job-check');
const { query, closeDb } = require('../src/db/connection');

const CRAWL_ATS = process.env.CRAWL_ATS || 'workday,icims,oracle,successfactors';

// --- crawl loop: fork the tested local crawler for the 4 sync-only platforms ---
let child = null;
let shuttingDown = false;
function startCrawler() {
  if (shuttingDown) return;
  child = fork(path.join(__dirname, 'crawl-companies-local.js'), [], {
    env: {
      ...process.env,
      ATS: CRAWL_ATS,
      CONCURRENCY: process.env.CONCURRENCY || '4',
      BATCH: process.env.BATCH || '30',
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
    try { const filled = await backfillDescriptions(); logger.info({ filled }, 'desc backfill cycle complete'); }
    catch (e) { logger.error({ err: e.message }, 'desc backfill error'); }
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
    if (rows.length) logger.info({ deleted: rows.length }, 'stale job cleanup');
  } catch (e) { logger.error({ err: e.message }, 'stale job cleanup error'); }
  setTimeout(runStaleCleanup, 6 * 60 * 60 * 1000);
}
async function runDeadPrune() {
  try { const r = await pruneDeadJobs({ limit: 400, concurrency: 10, tailDays: 30, recheckDays: 14 }); if (r.checked) logger.info(r, 'dead-job pruning'); }
  catch (e) { logger.error({ err: e.message }, 'dead-job pruning error'); }
  setTimeout(runDeadPrune, 60 * 60 * 1000);
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

logger.info({ crawlAts: CRAWL_ATS }, 'render-worker starting — crawl 4 sync-only platforms + maintenance (no Redis)');
startCrawler();
setTimeout(runDescBackfill, 5 * 60 * 1000);
setTimeout(runClassify, 2 * 60 * 1000);
setTimeout(runStaleCleanup, 5 * 60 * 1000);
setTimeout(runDeadPrune, 8 * 60 * 1000);
