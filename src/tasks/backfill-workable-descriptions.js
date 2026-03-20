/**
 * Backfill missing Workable job descriptions.
 * Fetches from v2 API one at a time with delays.
 * Runs independently from the sync queue to avoid blocking.
 */
const { query } = require('../db/connection');
const logger = require('../logger');

const DELAY_MS = 3000;
const FAIL_DELAY_MS = 1000;
const BATCH_SIZE = 100;

async function backfillDescriptions() {
  logger.info('Workable backfill: querying for jobs without descriptions');

  const { rows: jobs } = await query(
    `SELECT j.id, j.external_id, c.ats_slug
     FROM jobs j JOIN companies c ON j.company_id = c.id
     WHERE j.ats = 'workable' AND j.removed_at IS NULL
       AND (j.description IS NULL OR j.description = '')
     ORDER BY j.first_seen_at DESC
     LIMIT ?`,
    [BATCH_SIZE]
  );

  if (jobs.length === 0) {
    logger.info('Workable backfill: no jobs need descriptions');
    return 0;
  }

  logger.info({ count: jobs.length }, 'Workable backfill: starting batch');

  let filled = 0;
  let failed = 0;
  let skipped = 0;
  let consecutiveFailures = 0;

  for (const job of jobs) {
    // If we get 5 consecutive failures, the API is likely blocking us — bail early
    if (consecutiveFailures >= 5) {
      logger.warn(
        { consecutiveFailures, processed: filled + failed + skipped },
        'Workable backfill: too many consecutive failures, stopping batch early'
      );
      break;
    }

    const shortcode = job.external_id.replace('workable_', '');
    const slug = job.ats_slug;
    const url = `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(slug)}/jobs/${shortcode}`;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });

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
          consecutiveFailures = 0;
        } else {
          // API returned OK but no description content — mark with empty to skip next time
          skipped++;
          consecutiveFailures = 0;
          logger.debug({ jobId: job.id, slug, shortcode }, 'Workable backfill: API returned no description content');
        }
      } else {
        failed++;
        consecutiveFailures++;
        logger.warn(
          { jobId: job.id, slug, shortcode, status: res.status },
          'Workable backfill: non-OK response'
        );
      }
    } catch (err) {
      failed++;
      consecutiveFailures++;
      logger.warn(
        { jobId: job.id, slug, shortcode, err: err.message },
        'Workable backfill: fetch error'
      );
      await new Promise(r => setTimeout(r, FAIL_DELAY_MS));
      continue;
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  logger.info({ filled, failed, skipped, total: jobs.length }, 'Workable backfill: batch complete');
  return filled;
}

module.exports = { backfillDescriptions };
