/**
 * Phase 1 Task 4 dry-run (read-only, no writes): simulates the proposed
 * replacement for the skip-removal guard in jobs.js.
 *
 * Current production guard: when >50% of a company's stored jobs are missing
 * from the live incoming list, skip removal entirely — freezing genuine
 * closures right alongside partial-API-response glitches.
 *
 * Proposed replacement: never trust the list-diff for removal on its own.
 * For every "missing" job, verify via the SAME HTTP check the existing
 * dead-job-check.js pruner already uses in production (checkUrl — only
 * confirms dead on 404/410 or an explicit "no longer available" phrase,
 * everything else is left alone). Only HTTP-confirmed-dead jobs would be
 * removed; uncertain or still-alive-but-missing-from-the-feed jobs stay.
 *
 * This script does the live-fetch + verify end-to-end and reports what the
 * new logic WOULD do, against the actual "genuinely frozen" population
 * measured in production — without changing jobs.js or writing to the DB.
 *
 * Usage: DATABASE_URL=... NODE_ENV=production node scripts/dry-run-guard.js [--ats=workday] [--limit=6] [--max-missing-per-company=15]
 */
const { query, closeDb } = require('../src/db/connection');
const { getAdapter } = require('../src/adapters');
const { checkUrl, runWithConcurrency } = require('../src/tasks/dead-job-check');

const argAts = process.argv.find(a => a.startsWith('--ats='))?.split('=')[1];
const limit = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '4', 10);
const maxMissingPerCompany = parseInt(process.argv.find(a => a.startsWith('--max-missing-per-company='))?.split('=')[1] || '15', 10);

const TARGET_ATS = argAts ? [argAts] : [
  'workday', 'icims', 'oracle', 'zoho', 'smartrecruiters', 'greenhouse', 'pinpoint', 'ashby',
];

async function pickCompanies(ats, n) {
  // Same "genuinely frozen" definition used to scope this problem: synced
  // recently (under the current code) but no job rows refreshed since.
  // Sampling 20-200 stored jobs (not the largest) — the biggest tenants (TD Bank,
  // Walmart, 2000+ postings) take 10-30 min to re-crawl via detail-page fetching
  // regardless of guard logic, which just times out this harness without telling
  // us anything about removal-logic correctness.
  const { rows } = await query(`
    SELECT c.id, c.ats, c.ats_slug, cnt.total_jobs
    FROM companies c
    JOIN LATERAL (
      SELECT count(*) total_jobs,
             count(*) FILTER (WHERE j.last_seen_at > c.last_synced_at - interval '5 minutes') touched
      FROM jobs j WHERE j.company_id = c.id AND j.removed_at IS NULL
    ) cnt ON true
    WHERE c.ats = ?
      AND c.last_synced_at > now() - interval '6 hours'
      AND cnt.touched = 0 AND cnt.total_jobs BETWEEN 20 AND 200
    ORDER BY cnt.total_jobs ASC
    LIMIT ?
  `, [ats, n]);
  return rows;
}

async function dryRunCompany(company) {
  const { rows: existing } = await query(
    'SELECT id, external_id, url FROM jobs WHERE company_id = ? AND removed_at IS NULL',
    [company.id]
  );

  const adapter = getAdapter(company.ats);
  let incomingJobs = [];
  let error = null;
  try {
    const result = await Promise.race([
      adapter.fetchJobs(company.ats_slug),
      new Promise((_, reject) => setTimeout(() => reject(new Error('dry-run-timeout-90s')), 90000)),
    ]);
    incomingJobs = result.jobs || result || [];
  } catch (e) {
    error = e.message;
  }

  if (error) {
    return { companyId: company.id, ats: company.ats, slug: company.ats_slug, error, missing: 0, confirmedDead: 0, uncertain: 0, stillAlive: 0, noUrl: 0 };
  }

  const incomingIds = new Set(incomingJobs.map(j => j.external_id));
  const missingJobs = existing.filter(j => !incomingIds.has(j.external_id));

  // Under CURRENT production logic, would this company's removal have been skipped?
  const missingRatio = existing.length > 0 ? missingJobs.length / existing.length : 0;
  const currentGuardSkips = incomingJobs.length === 0 || missingRatio > 0.5;

  // Cap HTTP verification per company to bound total network calls in this dry run.
  const toVerify = missingJobs.slice(0, maxMissingPerCompany);

  let confirmedDead = 0, uncertain = 0, stillAlive = 0, noUrl = 0;
  const withUrl = toVerify.filter(j => j.url);
  noUrl = toVerify.length - withUrl.length;
  await runWithConcurrency(withUrl, 8, async (job) => {
    const result = await checkUrl(job.url);
    if (result.alive === false) confirmedDead++;
    else if (result.alive === true) stillAlive++;
    else uncertain++;
  });

  return {
    companyId: company.id, ats: company.ats, slug: company.ats_slug,
    existing: existing.length, incoming: incomingJobs.length,
    missing: missingJobs.length, verified: toVerify.length,
    currentGuardSkips, confirmedDead, uncertain, stillAlive, noUrl,
  };
}

async function main() {
  const summary = {};
  for (const ats of TARGET_ATS) {
    const companies = await pickCompanies(ats, limit);
    if (companies.length === 0) {
      console.log(`\n[${ats}] no genuinely-frozen companies found in the current sample window`);
      continue;
    }
    console.log(`\n[${ats}] dry-running ${companies.length} companies...`);
    summary[ats] = { companies: 0, missingTotal: 0, confirmedDead: 0, uncertain: 0, stillAlive: 0, noUrl: 0, wouldHaveBeenSkippedByOldGuard: 0 };
    for (const c of companies) {
      const d = await dryRunCompany(c);
      if (d.error) {
        console.log(`  company=${d.companyId} slug=${d.slug} ERROR: ${d.error}`);
        continue;
      }
      console.log(
        `  company=${d.companyId} slug=${d.slug} existing=${d.existing} incoming=${d.incoming} missing=${d.missing} ` +
        `(verified ${d.verified}: dead=${d.confirmedDead} uncertain=${d.uncertain} still_alive=${d.stillAlive} no_url=${d.noUrl}) ` +
        `oldGuardWouldSkip=${d.currentGuardSkips}`
      );
      summary[ats].companies++;
      summary[ats].missingTotal += d.missing;
      summary[ats].confirmedDead += d.confirmedDead;
      summary[ats].uncertain += d.uncertain;
      summary[ats].stillAlive += d.stillAlive;
      summary[ats].noUrl += d.noUrl;
      if (d.currentGuardSkips) summary[ats].wouldHaveBeenSkippedByOldGuard++;
    }
  }
  console.log('\n=== SUMMARY (sample) ===');
  console.log('confirmedDead = new logic WOULD remove | uncertain/stillAlive = new logic correctly KEEPS | wouldHaveBeenSkippedByOldGuard = old guard froze this company entirely');
  console.table(summary);
  await closeDb();
}

main().catch(e => { console.error(e); process.exit(1); });
