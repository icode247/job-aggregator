/**
 * Backfill salary data from job descriptions for jobs that have
 * descriptions but no salary information.
 * Processes in batches to avoid memory issues.
 */
const { query } = require('../src/db/connection');
const { extractSalary } = require('../src/utils/extract');

const BATCH_SIZE = 500;

async function backfillSalary() {
  console.log('Starting salary backfill...');

  let totalProcessed = 0;
  let totalFilled = 0;
  let offset = 0;

  while (true) {
    const { rows } = await query(`
      SELECT j.id, j.description
      FROM jobs j
      WHERE j.removed_at IS NULL
        AND (j.salary_min IS NULL OR j.salary_min = '')
        AND j.description IS NOT NULL
        AND LENGTH(j.description) > 50
      ORDER BY j.id
      LIMIT $1 OFFSET $2
    `, [BATCH_SIZE, offset]);

    if (rows.length === 0) break;

    let batchFilled = 0;
    for (const row of rows) {
      const salary = extractSalary(row.description);
      if (salary) {
        await query(`
          UPDATE jobs SET
            salary_min = $1, salary_max = $2,
            salary_currency = $3, salary_interval = $4
          WHERE id = $5
        `, [salary.min, salary.max, salary.currency, salary.interval, row.id]);
        batchFilled++;
      }
    }

    totalProcessed += rows.length;
    totalFilled += batchFilled;
    offset += BATCH_SIZE;

    if (totalProcessed % 5000 === 0 || rows.length < BATCH_SIZE) {
      console.log(`Processed: ${totalProcessed}, Filled: ${totalFilled} (${(totalFilled / totalProcessed * 100).toFixed(1)}%)`);
    }
  }

  console.log(`\nDone! Processed: ${totalProcessed}, Filled: ${totalFilled} (${(totalFilled / totalProcessed * 100).toFixed(1)}%)`);
  process.exit(0);
}

backfillSalary().catch(err => { console.error(err); process.exit(1); });
