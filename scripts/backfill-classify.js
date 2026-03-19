/**
 * One-time backfill: classify all existing active jobs with
 * is_remote, visa_sponsorship, and experience_level.
 *
 * Processes in batches of 1000 to avoid memory issues.
 * Safe to re-run (overwrites previous classifications).
 *
 * Usage: DATABASE_URL=... node scripts/backfill-classify.js
 */
const { query, closeDb } = require('../src/db/connection');
const { classifyJob } = require('../src/utils/classify');

const BATCH_SIZE = 1000;

async function backfill() {
  const { rows: [{ count }] } = await query(
    "SELECT COUNT(*) as count FROM jobs WHERE removed_at IS NULL"
  );
  const total = parseInt(count, 10);
  console.log(`Backfilling ${total} active jobs...`);

  let processed = 0;
  let lastId = 0;

  while (processed < total) {
    const { rows: jobs } = await query(
      `SELECT id, title, description, location, workplace_type
       FROM jobs
       WHERE removed_at IS NULL AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
      [lastId, BATCH_SIZE]
    );

    if (jobs.length === 0) break;

    for (const job of jobs) {
      const tags = classifyJob(job);

      await query(
        `UPDATE jobs SET is_remote = ?, visa_sponsorship = ?, experience_level = ? WHERE id = ?`,
        [tags.is_remote, tags.visa_sponsorship, tags.experience_level, job.id]
      );

      lastId = job.id;
    }

    processed += jobs.length;
    const pct = ((processed / total) * 100).toFixed(1);
    console.log(`  ${processed}/${total} (${pct}%) — last_id: ${lastId}`);
  }

  console.log('Done!');

  // Print summary
  const { rows: summary } = await query(`
    SELECT
      COUNT(*) FILTER (WHERE is_remote = TRUE) as remote_count,
      COUNT(*) FILTER (WHERE visa_sponsorship = 'yes') as visa_yes,
      COUNT(*) FILTER (WHERE visa_sponsorship = 'no') as visa_no,
      COUNT(*) FILTER (WHERE experience_level = 'internship') as intern,
      COUNT(*) FILTER (WHERE experience_level = 'entry') as entry,
      COUNT(*) FILTER (WHERE experience_level = 'mid') as mid,
      COUNT(*) FILTER (WHERE experience_level = 'senior') as senior,
      COUNT(*) FILTER (WHERE experience_level = 'lead') as lead,
      COUNT(*) FILTER (WHERE experience_level = 'executive') as exec,
      COUNT(*) as total
    FROM jobs WHERE removed_at IS NULL
  `);
  console.log('\nClassification summary:');
  console.log(JSON.stringify(summary[0], null, 2));

  await closeDb();
}

backfill().catch(err => { console.error(err); process.exit(1); });
