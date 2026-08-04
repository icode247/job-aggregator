#!/usr/bin/env node
/**
 * One-time salary re-fetch for existing paylocity jobs.
 *
 * ~17% of paylocity jobs (pay-transparency states) publish baseSalary in the detail page's JSON-LD,
 * which we historically dropped. The description backfill now captures it, but only for jobs it
 * processes (missing-description). This sweeps the already-described jobs: it re-fetches each detail
 * page via fetchDescription — whose paylocity path writes salary_* as a side-effect when baseSalary
 * is present (guarded by `salary_min IS NULL`). We only touch jobs with no salary yet.
 *
 * Rate-limited (the paylocity fetcher jitters + retries internally). Resumable via an id checkpoint.
 * Run: DATABASE_URL=... node scripts/refetch-paylocity-salary.js
 * Env: CONC(4) CHECKPOINT(/tmp/paylocity-salary.done)
 */
const fs = require('fs');
const { fetchDescription } = require('../src/tasks/backfill-descriptions');
const { query, closeDb } = require('../src/db/connection');
const logger = require('../src/logger');

const CONC = parseInt(process.env.CONC || '4', 10);
const CHECKPOINT = process.env.CHECKPOINT || '/tmp/paylocity-salary.done';

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }
  const done = new Set();
  try { fs.readFileSync(CHECKPOINT, 'utf8').split('\n').forEach((l) => l.trim() && done.add(l.trim())); } catch { /* fresh */ }

  // Keyset-paginate (WHERE id > lastId) so we never load all ~85k rows at once (that read-timed-out).
  const PAGE = 2000;
  const pending = [];
  let lastId = 0;
  for (;;) {
    const { rows } = await query(
      `SELECT id, ats, url FROM jobs
        WHERE ats = 'paylocity' AND removed_at IS NULL AND url IS NOT NULL AND salary_min IS NULL AND id > $1
        ORDER BY id LIMIT $2`, [lastId, PAGE]);
    if (!rows.length) break;
    for (const r of rows) if (!done.has(String(r.id))) pending.push(r);
    lastId = rows[rows.length - 1].id;
  }
  logger.info({ pending: pending.length, conc: CONC }, 'paylocity salary re-fetch starting');

  let processed = 0, filled = 0;
  const t0 = Date.now();
  const ckBuf = [];
  const flushCk = () => { if (ckBuf.length) { try { fs.appendFileSync(CHECKPOINT, ckBuf.splice(0).join('\n') + '\n'); } catch { /* ignore */ } } };

  for (let i = 0; i < pending.length; i += CONC) {
    const batch = pending.slice(i, i + CONC);
    await Promise.all(batch.map(async (job) => {
      try { await fetchDescription(job); } catch { /* side-effect writes salary; ignore desc errors */ }
      // did salary land?
      try { const r = await query('SELECT salary_min FROM jobs WHERE id = $1', [job.id]); if (r.rows[0]?.salary_min) filled++; } catch { /* ignore */ }
      processed++; ckBuf.push(String(job.id));
    }));
    flushCk();
    if (processed % 500 < CONC) {
      const rate = (processed / ((Date.now() - t0) / 1000)).toFixed(1);
      logger.info({ processed, filled, pct: ((processed / pending.length) * 100).toFixed(1) + '%', rate: rate + '/s' }, 'progress');
    }
  }
  flushCk();
  logger.info({ processed, salaryFilled: filled, minutes: ((Date.now() - t0) / 60000).toFixed(1) }, 'paylocity salary re-fetch COMPLETE');
  await closeDb();
  process.exit(0);
})().catch((e) => { logger.error({ err: e.message }, 'paylocity salary re-fetch fatal'); process.exit(1); });
