/**
 * One-off script: reset visa_sponsorship to NULL so the backfill
 * re-classifies all jobs with the updated patterns.
 *
 * Usage: node scripts/reset-visa-classification.js
 */
const { migrate, closeDb } = require('../src/db');
const { query } = require('../src/db/connection');

async function main() {
  await migrate();

  // Count current classifications
  const { rows: before } = await query(
    `SELECT visa_sponsorship, COUNT(*) as cnt
     FROM jobs WHERE removed_at IS NULL
     GROUP BY visa_sponsorship`
  );
  console.log('Before reset:', before);

  // Reset all visa classifications to NULL
  const { rows } = await query(
    `UPDATE jobs SET visa_sponsorship = NULL
     WHERE removed_at IS NULL AND visa_sponsorship IS NOT NULL
     RETURNING id`
  );
  console.log(`Reset ${rows.length} jobs visa_sponsorship to NULL`);
  console.log('The backfill worker will re-classify them with updated patterns.');

  await closeDb();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
