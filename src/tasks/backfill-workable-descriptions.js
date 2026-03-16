/**
 * Backfill missing Workable job descriptions.
 * Fetches from v2 API one at a time with 5s delays.
 * Runs independently from the sync queue to avoid blocking.
 */
const { query } = require('../db/connection');
const logger = require('../logger');

const DELAY_MS = 5000;
const BATCH_SIZE = 50;

async function backfillDescriptions() {
  const { rows: jobs } = await query(
    `SELECT j.id, j.external_id, c.ats_slug
     FROM jobs j JOIN companies c ON j.company_id = c.id
     WHERE j.ats = 'workable' AND j.removed_at IS NULL AND j.description IS NULL
     ORDER BY j.first_seen_at DESC
     LIMIT ?`,
    [BATCH_SIZE]
  );

  if (jobs.length === 0) {
    logger.info('Workable backfill: no jobs need descriptions');
    return 0;
  }

  logger.info({ count: jobs.length }, 'Workable backfill: starting');

  let filled = 0;

  for (const job of jobs) {
    const shortcode = job.external_id.replace('workable_', '');
    const slug = job.ats_slug;

    try {
      const res = await fetch(
        `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(slug)}/jobs/${shortcode}`,
        { signal: AbortSignal.timeout(5000) }
      );

      if (res.ok) {
        const detail = await res.json();
        const parts = [detail.description, detail.requirements, detail.benefits].filter(Boolean);
        const description = parts.join('\n') || null;

        if (description) {
          await query(
            'UPDATE jobs SET description = ? WHERE id = ?',
            [description, job.id]
          );
          filled++;
        }
      }
    } catch {
      // Blocked — wait longer and continue
      await new Promise(r => setTimeout(r, DELAY_MS * 2));
      continue;
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  logger.info({ filled, total: jobs.length }, 'Workable backfill: complete');
  return filled;
}

module.exports = { backfillDescriptions };
