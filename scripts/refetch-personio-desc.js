#!/usr/bin/env node
/**
 * One-time corrective re-fetch of personio descriptions from the HTML job page.
 *
 * Personio's XML feed serves empty descriptions, so personio jobs either have NULL or a
 * low-quality aggregator AI-summary (from resumly/liftmycv import) that doesn't match the real
 * posting. The normal backfill only touches NULL descriptions, so the wrong summaries would persist.
 * This OVERWRITES every active personio job's description with the real one from its HTML page.
 *
 * Rate-limited (personio 429s easily). Resumable via a processed-id checkpoint.
 * Run: DATABASE_URL=... node scripts/refetch-personio-desc.js   (DRY=1 to report only)
 */
const fs = require('fs');
const { fetchDescription } = require('../src/tasks/backfill-descriptions');
const { query, closeDb } = require('../src/db/connection');
const logger = require('../src/logger');

const DRY = process.env.DRY === '1';
const DELAY_MS = parseInt(process.env.DELAY_MS || '1500', 10); // gentle — personio rate-limits
const CHECKPOINT = process.env.CHECKPOINT || '/tmp/personio-refetch.done';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }
  const done = new Set();
  try { fs.readFileSync(CHECKPOINT, 'utf8').split('\n').forEach((l) => l.trim() && done.add(l.trim())); } catch { /* fresh */ }

  const { rows } = await query(
    `SELECT j.id, j.ats, j.external_id, j.url, c.ats_slug
       FROM jobs j JOIN companies c ON c.id = j.company_id
      WHERE j.ats = 'personio' AND j.removed_at IS NULL AND j.url IS NOT NULL AND j.url <> ''
      ORDER BY j.first_seen_at DESC`);
  const pending = rows.filter((r) => !done.has(String(r.id)));
  logger.info({ total: rows.length, pending: pending.length, dry: DRY }, 'personio re-fetch starting');

  let fixed = 0, skipped = 0, failed = 0, i = 0;
  for (const job of pending) {
    i++;
    try {
      const desc = await fetchDescription(job); // now HTML-based
      if (desc && desc !== 'SKIP') {
        if (!DRY) await query('UPDATE jobs SET description = $1 WHERE id = $2', [desc, job.id]);
        fixed++;
      } else { skipped++; }
    } catch (e) { failed++; logger.debug({ id: job.id, err: e.message }, 'refetch failed'); }
    if (!DRY) { try { fs.appendFileSync(CHECKPOINT, String(job.id) + '\n'); } catch { /* ignore */ } }
    if (i % 25 === 0) logger.info({ i, total: pending.length, fixed, skipped, failed }, 'progress');
    await sleep(DELAY_MS);
  }
  logger.info({ fixed, skipped, failed, dry: DRY }, 'personio re-fetch COMPLETE');
  await closeDb();
  process.exit(0);
})().catch((e) => { logger.error({ err: e.message }, 'personio re-fetch fatal'); process.exit(1); });
