#!/usr/bin/env node
/**
 * Check if jobs with NULL descriptions are still available on their career pages.
 * Fetches each job URL and checks for dead-page indicators.
 * Outputs a report and optionally marks dead jobs for removal.
 *
 * Usage:
 *   node scripts/check-dead-jobs.js                  # Check all ATS, dry-run (prints SQL)
 *   node scripts/check-dead-jobs.js --ats=zoho       # Check only Zoho
 *   node scripts/check-dead-jobs.js --ats=zoho --limit=50
 *   node scripts/check-dead-jobs.js --all-jobs        # Check ALL jobs, not just NULL description
 *   node scripts/check-dead-jobs.js --prune           # Actually mark dead jobs removed (not a dry-run)
 *
 * Requires DATABASE_URL env var (set via `heroku config:get DATABASE_URL`)
 */

const { Pool } = require('pg');
// Liveness logic is shared with the worker's runDeadJobPruning (src/tasks/dead-job-check.js).
const { checkUrl, runWithConcurrency } = require('../src/tasks/dead-job-check');

const args = process.argv.slice(2);
const atsFilter = args.find(a => a.startsWith('--ats='))?.split('=')[1] || null;
const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '500', 10);
const allJobs = args.includes('--all-jobs');
const prune = args.includes('--prune');
const concurrency = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] || '10', 10);

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL not set. Run:\n  export DATABASE_URL=$(heroku config:get DATABASE_URL -a fastapply-board)');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });

  let whereClause = "j.removed_at IS NULL AND j.url IS NOT NULL";
  if (!allJobs) {
    whereClause += " AND j.description IS NULL";
  }
  if (atsFilter) {
    whereClause += ` AND j.ats = '${atsFilter}'`;
  }

  const { rows: jobs } = await pool.query(`
    SELECT j.id, j.ats, j.title, j.url, c.ats_slug, c.company_name
    FROM jobs j JOIN companies c ON j.company_id = c.id
    WHERE ${whereClause}
    ORDER BY j.ats, j.first_seen_at DESC
    LIMIT $1
  `, [limit]);

  console.log(`\nChecking ${jobs.length} jobs (${atsFilter || 'all ATS'}, ${allJobs ? 'all jobs' : 'NULL description only'}, concurrency: ${concurrency})\n`);

  const dead = [];
  const alive = [];
  const uncertain = [];

  await runWithConcurrency(jobs, concurrency, async (job, i) => {
    const result = await checkUrl(job.url);
    const status = result.alive === true ? '✅' : result.alive === false ? '💀' : '❓';
    const progress = `[${i + 1}/${jobs.length}]`;

    if (result.alive === false) {
      dead.push({ ...job, reason: result.reason });
      console.log(`${progress} ${status} DEAD: ${job.ats}/${job.ats_slug} — "${job.title}" — ${result.reason}`);
    } else if (result.alive === null) {
      uncertain.push({ ...job, reason: result.reason });
      console.log(`${progress} ${status} UNCERTAIN: ${job.ats}/${job.ats_slug} — "${job.title}" — ${result.reason}`);
    } else {
      alive.push(job);
      if ((i + 1) % 50 === 0) {
        console.log(`${progress} Checked... (${alive.length} alive, ${dead.length} dead, ${uncertain.length} uncertain)`);
      }
    }
  });

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log(`RESULTS: ${alive.length} alive, ${dead.length} dead, ${uncertain.length} uncertain`);
  console.log('='.repeat(70));

  if (dead.length > 0) {
    console.log('\n💀 DEAD JOBS:');
    const byCompany = {};
    for (const j of dead) {
      const key = `${j.ats}/${j.ats_slug} (${j.company_name})`;
      byCompany[key] = (byCompany[key] || 0) + 1;
    }
    for (const [company, count] of Object.entries(byCompany).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${company}: ${count} dead jobs`);
    }

    // Remove dead jobs (with --prune) or just emit the SQL (default dry-run).
    const deadIds = dead.map(j => j.id);
    if (prune) {
      await pool.query('UPDATE jobs SET removed_at = NOW() WHERE id = ANY($1::bigint[])', [deadIds]);
      console.log(`\n✅ Pruned ${dead.length} dead jobs (removed_at set).`);
    } else {
      console.log(`\n-- SQL to mark ${dead.length} dead jobs as removed (re-run with --prune to apply):`);
      console.log(`UPDATE jobs SET removed_at = NOW() WHERE id IN (${deadIds.join(',')});`);
    }
  }

  if (uncertain.length > 0) {
    console.log('\n❓ UNCERTAIN (could not determine):');
    const byReason = {};
    for (const j of uncertain) {
      byReason[j.reason] = (byReason[j.reason] || 0) + 1;
    }
    for (const [reason, count] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${reason}: ${count} jobs`);
    }
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
