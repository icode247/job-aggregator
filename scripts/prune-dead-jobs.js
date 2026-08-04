#!/usr/bin/env node
/**
 * Prune DEAD job postings — active jobs whose apply URL definitively returns HTTP 404/410 (Gone).
 *
 * Aggregator/demand-imported jobs aren't in the crawl rotation, so the normal liveness pruning
 * never reaches them; removed postings accumulate on the board (often stuck with description=NULL
 * or 'N/A'). This probes each candidate URL and soft-deletes (removed_at=NOW(), matching liveness
 * pruning) ONLY on 404/410 — never on 200, redirects, timeouts, or network errors (those are live
 * or transient). Conservative by design: false positives would wrongly hide live jobs.
 *
 * Scope: active jobs with no real description (description IS NULL OR 'N/A') and a URL — the backlog
 * where dead postings concentrate. Resumable via a processed-id checkpoint.
 *
 * Run:  DATABASE_URL=... node scripts/prune-dead-jobs.js
 *       DATABASE_URL=... DRY=1 node scripts/prune-dead-jobs.js     # probe + report, delete nothing
 * Env:  PRUNE_CONC(25) PRUNE_TIMEOUT_MS(12000) CHECKPOINT(/tmp/prune-dead.done)
 */
const fs = require('fs');
const { query, closeDb } = require('../src/db/connection');
const logger = require('../src/logger');

const CONC = parseInt(process.env.PRUNE_CONC || '25', 10);
const TIMEOUT = parseInt(process.env.PRUNE_TIMEOUT_MS || '12000', 10);
const DRY = process.env.DRY === '1';
const CHECKPOINT = process.env.CHECKPOINT || '/tmp/prune-dead.done';

async function probeDead(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
    if (res.body && res.body.cancel) res.body.cancel().catch(() => {}); // don't download the body
    return res.status === 404 || res.status === 410; // definitively gone
  } catch {
    return false; // timeout / DNS / reset — transient, treat as LIVE (never prune)
  }
}

async function flushDead(ids) {
  if (!ids.length || DRY) return ids.length;
  // Soft-delete in one statement; matches the liveness-pruning marker so a later re-crawl can revive.
  await query('UPDATE jobs SET removed_at = NOW() WHERE id = ANY($1) AND removed_at IS NULL', [ids]);
  return ids.length;
}

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }
  const done = new Set();
  try { fs.readFileSync(CHECKPOINT, 'utf8').split('\n').forEach((l) => l.trim() && done.add(l.trim())); } catch { /* fresh */ }

  const { rows } = await query(
    `SELECT j.id, j.url FROM jobs j
       WHERE j.removed_at IS NULL AND (j.description IS NULL OR j.description = 'N/A')
         AND j.url IS NOT NULL AND j.url <> ''
       ORDER BY j.first_seen_at DESC`);
  const pending = rows.filter((r) => !done.has(String(r.id)));
  logger.info({ total: rows.length, alreadyDone: done.size, pending: pending.length, dry: DRY }, 'prune-dead starting');

  let processed = 0, dead = 0, live = 0;
  const t0 = Date.now();
  let deadBatch = [], ckBatch = [];
  for (let i = 0; i < pending.length; i += CONC) {
    const slice = pending.slice(i, i + CONC);
    const verdicts = await Promise.all(slice.map((j) => probeDead(j.url)));
    for (let k = 0; k < slice.length; k++) {
      processed++; ckBatch.push(String(slice[k].id));
      if (verdicts[k]) { dead++; deadBatch.push(slice[k].id); } else live++;
    }
    if (deadBatch.length >= 200) { await flushDead(deadBatch); deadBatch = []; }
    if (ckBatch.length >= 500) { if (!DRY) { try { fs.appendFileSync(CHECKPOINT, ckBatch.join('\n') + '\n'); } catch { /* ignore */ } } ckBatch = []; }
    if (processed % 2000 === 0) {
      const rate = (processed / ((Date.now() - t0) / 1000)).toFixed(0);
      logger.info({ processed, dead, live, rate: rate + '/s', pct: ((processed / pending.length) * 100).toFixed(1) + '%' }, 'prune-dead progress');
    }
  }
  await flushDead(deadBatch);
  if (ckBatch.length && !DRY) { try { fs.appendFileSync(CHECKPOINT, ckBatch.join('\n') + '\n'); } catch { /* ignore */ } }
  logger.info({ processed, dead, live, pruned: DRY ? 0 : dead, minutes: ((Date.now() - t0) / 60000).toFixed(1), dry: DRY }, 'prune-dead COMPLETE');
  await closeDb();
  process.exit(0);
})().catch((e) => { logger.error({ err: e.message, stack: e.stack }, 'prune-dead fatal'); process.exit(1); });
