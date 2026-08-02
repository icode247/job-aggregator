/**
 * Phase 1 diagnostic (read-only, no writes): for a sample of companies that were
 * synced recently but had zero jobs touched, live-call the adapter and compare
 * incoming external_ids against what's stored. Classifies each company so we know
 * how much of the freeze is fixed by dropping the ingest-time age filter (already
 * shipped) vs. how much needs a reconciliation pass for mismatched external_id
 * namespaces (legacy bulk imports using a different id derivation than the live
 * adapter).
 *
 * Usage: DATABASE_URL=... node scripts/diagnose-freeze.js [--ats=smartrecruiters] [--limit=8]
 */
const { query, closeDb } = require('../src/db/connection');
const { getAdapter } = require('../src/adapters');

const argAts = process.argv.find(a => a.startsWith('--ats='))?.split('=')[1];
const limit = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '6', 10);

const TARGET_ATS = argAts ? [argAts] : [
  'smartrecruiters', 'greenhouse', 'oracle', 'zoho', 'ashby', 'rippling', 'icims', 'breezy', 'workday',
];

async function pickCompanies(ats, n) {
  const { rows } = await query(`
    SELECT c.id, c.ats, c.ats_slug, cnt.total_jobs
    FROM companies c
    JOIN LATERAL (
      SELECT count(*) total_jobs,
             count(*) FILTER (WHERE j.last_seen_at > now() - interval '2 days') touched
      FROM jobs j WHERE j.company_id = c.id AND j.removed_at IS NULL
    ) cnt ON true
    WHERE c.ats = ?
      AND c.last_synced_at > now() - interval '12 hours'
      AND cnt.touched = 0 AND cnt.total_jobs > 0
    ORDER BY cnt.total_jobs DESC
    LIMIT ?
  `, [ats, n]);
  return rows;
}

async function diagnoseCompany(company) {
  const { rows: existing } = await query(
    'SELECT external_id FROM jobs WHERE company_id = ? AND removed_at IS NULL',
    [company.id]
  );
  const existingIds = new Set(existing.map(r => r.external_id));

  const adapter = getAdapter(company.ats);
  let incomingJobs = [];
  let error = null;
  try {
    // Some adapters (icims/oracle/smartrecruiters) fetch a detail page per job —
    // for a company with hundreds of postings that's hundreds of HTTP calls.
    // Hard-cap per-company diagnosis time so one slow company can't stall the batch.
    const result = await Promise.race([
      adapter.fetchJobs(company.ats_slug),
      new Promise((_, reject) => setTimeout(() => reject(new Error('diagnose-timeout-45s')), 45000)),
    ]);
    incomingJobs = result.jobs || result || [];
  } catch (e) {
    error = e.message;
  }

  const incomingIds = new Set(incomingJobs.map(j => j.external_id));
  const matched = [...existingIds].filter(id => incomingIds.has(id)).length;
  const missing = existingIds.size - matched;

  let verdict;
  if (error) verdict = `ADAPTER_ERROR: ${error}`;
  else if (incomingJobs.length === 0) verdict = 'ADAPTER_RETURNED_EMPTY (transient or dead company — needs manual check)';
  else if (matched === 0) verdict = 'ID_NAMESPACE_MISMATCH (needs reconciliation pass, age-filter fix does not help)';
  else if (missing / existingIds.size > 0.5) verdict = 'PARTIAL_MATCH (legacy rows likely stale/reposted under new ids)';
  else verdict = 'OK (age-filter removal should keep this fresh going forward)';

  return {
    companyId: company.id, ats: company.ats, slug: company.ats_slug,
    existing: existingIds.size, incoming: incomingJobs.length, matched, missing, verdict,
  };
}

async function main() {
  const summary = {};
  for (const ats of TARGET_ATS) {
    const companies = await pickCompanies(ats, limit);
    if (companies.length === 0) {
      console.log(`\n[${ats}] no zero-touched recently-synced companies found in sample window`);
      continue;
    }
    console.log(`\n[${ats}] sampling ${companies.length} companies...`);
    for (const c of companies) {
      const d = await diagnoseCompany(c);
      console.log(
        `  company=${d.companyId} slug=${d.slug} existing=${d.existing} incoming=${d.incoming} matched=${d.matched} -> ${d.verdict}`
      );
      summary[ats] = summary[ats] || { ID_NAMESPACE_MISMATCH: 0, PARTIAL_MATCH: 0, OK: 0, EMPTY_OR_ERROR: 0 };
      if (d.verdict.startsWith('ID_NAMESPACE_MISMATCH')) summary[ats].ID_NAMESPACE_MISMATCH++;
      else if (d.verdict.startsWith('PARTIAL_MATCH')) summary[ats].PARTIAL_MATCH++;
      else if (d.verdict.startsWith('OK')) summary[ats].OK++;
      else summary[ats].EMPTY_OR_ERROR++;
    }
  }
  console.log('\n=== SUMMARY (sample counts per ATS) ===');
  console.table(summary);
  await closeDb();
}

main().catch(e => { console.error(e); process.exit(1); });
