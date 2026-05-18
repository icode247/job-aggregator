#!/usr/bin/env node
/**
 * Verify the four ATS fetcher fixes by running the REAL `fetchDescription`
 * against a sample of jobs currently missing descriptions in prod.
 *
 * Read-only by default. Pass --apply to UPDATE rows (writing description or
 * 'N/A' depending on outcome).
 *
 * Usage:
 *   DATABASE_URL=$(heroku config:get DATABASE_URL -a fastapply-board) \
 *     node scripts/verify-fetcher-fixes.js
 *
 *   # Apply the fixes against the full backlog of 450 missing rows:
 *   DATABASE_URL=... node scripts/verify-fetcher-fixes.js \
 *     --samples=1000 --apply
 */

'use strict';

const { Pool } = require('pg');
const { fetchDescription } = require('../src/tasks/backfill-descriptions');

const args = process.argv.slice(2);
const argFor = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const APPLY      = args.includes('--apply');
const ATS_FILTER = argFor('ats', null);
const SAMPLES    = parseInt(argFor('samples', '3'), 10);

const TARGET_ATSES = ATS_FILTER
  ? [ATS_FILTER]
  : ['zoho', 'lever', 'smartrecruiters', 'workday'];

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set.');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 4,
  connectionTimeoutMillis: 10000,
});

const banner = (s) => console.log('\n' + '═'.repeat(78) + '\n' + s + '\n' + '═'.repeat(78));
const sub    = (s) => console.log('\n── ' + s + ' ' + '─'.repeat(Math.max(0, 73 - s.length)));

async function main() {
  banner(`Fetcher-fix verifier`
    + `\n  ATSes:   ${TARGET_ATSES.join(', ')}`
    + `\n  samples: up to ${SAMPLES} per ATS`
    + `\n  apply:   ${APPLY ? 'YES (will write description / N/A)' : 'no (dry run)'}`);

  const summary = {};

  for (const ats of TARGET_ATSES) {
    sub(`ATS: ${ats}`);
    const { rows: jobs } = await pool.query(
      `SELECT j.id, j.ats, j.external_id, j.url, j.raw_data, c.ats_slug
         FROM jobs j JOIN companies c ON j.company_id = c.id
        WHERE j.removed_at IS NULL
          AND (j.description IS NULL OR j.description = '')
          AND j.ats = $1
        ORDER BY j.first_seen_at DESC
        LIMIT $2`,
      [ats, SAMPLES],
    );
    if (jobs.length === 0) {
      console.log('  (no missing-description jobs for this ATS)');
      continue;
    }
    console.log(`  Probing ${jobs.length} job(s)...`);

    const buckets = { filled: 0, skipped: 0, failed: 0, applied: 0, marked_na: 0 };
    let exampleFilled = null;

    for (const job of jobs) {
      let result;
      try {
        result = await fetchDescription(job);
      } catch (err) {
        result = { __error: err.message };
      }

      if (result && typeof result === 'string' && result !== 'SKIP') {
        buckets.filled++;
        if (!exampleFilled) exampleFilled = { id: job.id, slug: job.ats_slug, preview: result.slice(0, 120).replace(/\s+/g, ' ') };
        if (APPLY) {
          await pool.query('UPDATE jobs SET description = $1 WHERE id = $2', [result, job.id]);
          buckets.applied++;
        }
      } else if (result === 'SKIP') {
        buckets.skipped++;
        if (APPLY) {
          await pool.query("UPDATE jobs SET description = 'N/A' WHERE id = $1", [job.id]);
          buckets.marked_na++;
        }
      } else {
        buckets.failed++;
        if (result && result.__error) console.log(`    err on id=${job.id}: ${result.__error}`);
      }
    }

    summary[ats] = { total: jobs.length, ...buckets, exampleFilled };

    console.log(`  filled: ${buckets.filled}   skipped(N/A): ${buckets.skipped}   failed: ${buckets.failed}`);
    if (exampleFilled) {
      console.log(`  ✓ sample filled: id=${exampleFilled.id} slug=${exampleFilled.slug}`);
      console.log(`    preview: ${exampleFilled.preview}…`);
    }
  }

  banner('SUMMARY');
  for (const [ats, s] of Object.entries(summary)) {
    const recoverPct = Math.round((s.filled / s.total) * 100);
    const skipPct    = Math.round((s.skipped / s.total) * 100);
    const failPct    = Math.round((s.failed / s.total) * 100);
    console.log(`\n  ${ats}: probed ${s.total}`);
    console.log(`    filled:   ${String(s.filled).padStart(4)}  (${recoverPct}%)`);
    console.log(`    skipped:  ${String(s.skipped).padStart(4)}  (${skipPct}%)   ${APPLY ? '→ marked N/A' : ''}`);
    console.log(`    failed:   ${String(s.failed).padStart(4)}  (${failPct}%)   ${failPct > 0 ? '← still null, will retry' : ''}`);
    if (APPLY) console.log(`    applied:  ${s.applied} descriptions written, ${s.marked_na} marked N/A`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('FATAL:', err);
  pool.end().catch(() => {});
  process.exit(1);
});
