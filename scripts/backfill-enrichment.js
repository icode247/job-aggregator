/**
 * One-time backfill script: extract salary, workplace_type, and employment_type
 * from existing job descriptions where those fields are currently NULL.
 * Run: node scripts/backfill-enrichment.js
 */
const { migrate, closeDb } = require('../src/db');
const { query } = require('../src/db/connection');
const { extractSalary, extractWorkplaceType, extractEmploymentType } = require('../src/utils/extract');
const { stripHtml } = require('../src/utils/html');

async function main() {
  await migrate();

  const BATCH_SIZE = 500;
  let offset = 0;
  let totalSalary = 0;
  let totalWorkplace = 0;
  let totalEmployment = 0;
  let processed = 0;

  while (true) {
    const { rows } = await query(
      `SELECT id, title, location, description, salary_min, workplace_type, employment_type
       FROM jobs WHERE removed_at IS NULL AND description IS NOT NULL AND description != ''
       ORDER BY id LIMIT ? OFFSET ?`,
      [BATCH_SIZE, offset]
    );
    if (rows.length === 0) break;

    for (const job of rows) {
      const plainDesc = stripHtml(job.description);
      const updates = [];
      const params = [];

      if (!job.salary_min) {
        const salary = extractSalary(plainDesc);
        if (salary) {
          updates.push('salary_min = ?', 'salary_max = ?', 'salary_currency = ?', 'salary_interval = ?');
          params.push(salary.min, salary.max, salary.currency, salary.interval);
          totalSalary++;
        }
      }
      if (!job.workplace_type) {
        const wt = extractWorkplaceType(job.title, job.location, plainDesc);
        if (wt) { updates.push('workplace_type = ?'); params.push(wt); totalWorkplace++; }
      }
      if (!job.employment_type) {
        const et = extractEmploymentType(job.title, plainDesc);
        if (et) { updates.push('employment_type = ?'); params.push(et); totalEmployment++; }
      }

      if (updates.length > 0) {
        params.push(job.id);
        await query(`UPDATE jobs SET ${updates.join(', ')} WHERE id = ?`, params);
      }
    }

    processed += rows.length;
    if (processed % 5000 === 0) {
      console.log(`Processed ${processed} jobs — salary: ${totalSalary}, workplace: ${totalWorkplace}, employment: ${totalEmployment}`);
    }
    offset += BATCH_SIZE;
  }

  console.log(`Done! Processed ${processed} jobs`);
  console.log(`Enriched — salary: ${totalSalary}, workplace: ${totalWorkplace}, employment: ${totalEmployment}`);
  await closeDb();
}

main().catch(err => { console.error(err); process.exit(1); });
