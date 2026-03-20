/**
 * Backfill classification fields (visa_sponsorship, experience_level, is_remote, remote_worldwide)
 * for existing jobs that have descriptions but haven't been classified yet.
 * Runs in batches to avoid locking the database.
 */
const { query } = require('../db/connection');
const { classifyJob } = require('../utils/classify');
const logger = require('../logger');

const BATCH_SIZE = 5000;

async function backfillClassifications() {
  // Find jobs with descriptions but no visa_sponsorship classification
  // (visa_sponsorship is null for all unclassified jobs)
  const { rows: jobs } = await query(
    `SELECT id, title, description, location, workplace_type
     FROM jobs
     WHERE removed_at IS NULL
       AND description IS NOT NULL
       AND description != ''
       AND (visa_sponsorship IS NULL)
     ORDER BY first_seen_at DESC
     LIMIT ?`,
    [BATCH_SIZE]
  );

  if (jobs.length === 0) {
    logger.info('Classification backfill: all jobs classified');
    return 0;
  }

  logger.info({ count: jobs.length }, 'Classification backfill: starting batch');

  let classified = 0;

  for (const job of jobs) {
    const classification = classifyJob(job);

    await query(
      `UPDATE jobs SET
        visa_sponsorship = ?,
        experience_level = ?,
        is_remote = ?,
        remote_worldwide = ?
      WHERE id = ?`,
      [
        classification.visa_sponsorship || '',
        classification.experience_level || '',
        classification.is_remote,
        classification.remote_worldwide,
        job.id,
      ]
    );
    classified++;
  }

  logger.info({ classified, total: jobs.length }, 'Classification backfill: batch complete');
  return classified;
}

module.exports = { backfillClassifications };
