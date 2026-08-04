#!/usr/bin/env node
/**
 * Directly crawls the pending allscmjobs companies' ATS feeds and upserts their
 * jobs to Postgres — bypassing the worker's slow rotation (and the gap where the
 * worker never schedules iCIMS at all).
 *
 * Reuses the SAME adapters + jobsRepo.syncForCompany the worker uses, so the rows
 * are identical to a normal worker sync (classification, dedup, 30-day freshness).
 *
 * Run:
 *   DATABASE_URL=$(heroku config:get DATABASE_URL -a fastapply-board) NODE_ENV=production \
 *     node scripts/crawl-allscm-jobs.js
 *
 * Env: CONCURRENCY (default 8), ATS (comma list to restrict), ORIGIN (default allscmjobs).
 */
const { getAdapter } = require('../src/adapters');
const { companiesRepo, jobsRepo } = require('../src/db');
const { query } = require('../src/db/connection');
const { extractSalary, extractWorkplaceType, extractEmploymentType } = require('../src/utils/extract');
const { stripHtml } = require('../src/utils/html');
const { classifyJob } = require('../src/utils/classify');

// ATS the allscmjobs feed maps to, all with working adapters (verified incl. iCIMS).
const DEFAULT_ATS = ['greenhouse','lever','ashby','workable','bamboohr','smartrecruiters','rippling','jazzhr','pinpoint','breezy','recruitee','zoho','workday','icims'];
const ATS = (process.env.ATS ? process.env.ATS.split(',') : DEFAULT_ATS).map(s => s.trim()).filter(Boolean);
const ORIGIN = process.env.ORIGIN || 'allscmjobs';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '8');
const FETCH_TIMEOUT = parseInt(process.env.FETCH_TIMEOUT || '60000');

const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('fetch timeout ' + label)), ms))]);

async function processCompany(co) {
  const adapter = getAdapter(co.ats);
  const result = await withTimeout(adapter.fetchJobs(co.ats_slug), FETCH_TIMEOUT, co.ats);
  const incoming = (result && (result.jobs || result)) || [];
  if (!incoming.length) { await companiesRepo.updateLastSynced(co.id).catch(() => {}); return { jobs: 0, added: 0 }; }

  for (const job of incoming) {
    const plainDesc = job.description ? stripHtml(job.description) : null;
    if (!job.salary_min && plainDesc) {
      const s = extractSalary(plainDesc);
      if (s) { job.salary_min = s.min; job.salary_max = s.max; job.salary_currency = s.currency; job.salary_interval = s.interval; }
    }
    if (!job.workplace_type) job.workplace_type = extractWorkplaceType(job.title, job.location, plainDesc);
    if (!job.employment_type) job.employment_type = extractEmploymentType(job.title, plainDesc);
    const tags = classifyJob(job);
    job.is_remote = tags.is_remote;
    job.remote_worldwide = tags.remote_worldwide;
    job.experience_level = tags.experience_level;
  }

  const diff = await jobsRepo.syncForCompany(co.id, co.ats, incoming);
  await companiesRepo.updateLastSynced(co.id).catch(() => {});
  return { jobs: incoming.length, added: diff.added };
}

(async () => {
  const il = ATS.map(a => "'" + a + "'").join(',');
  const { rows: companies } = await query(
    `SELECT id, ats, ats_slug, company_name FROM companies
       WHERE origin = '${ORIGIN}' AND ats IN (${il}) AND ats_slug IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.company_id = companies.id)
       ORDER BY ats`
  );
  console.log(`Crawling ${companies.length} pending '${ORIGIN}' companies | ATS: ${ATS.join(',')} | concurrency ${CONCURRENCY}`);

  let idx = 0, done = 0, totalJobs = 0, totalAdded = 0, errors = 0, withJobs = 0;
  const byAtsAdded = {};
  async function worker() {
    while (idx < companies.length) {
      const co = companies[idx++];
      try {
        const r = await processCompany(co);
        totalJobs += r.jobs; totalAdded += r.added;
        if (r.jobs > 0) { withJobs++; byAtsAdded[co.ats] = (byAtsAdded[co.ats] || 0) + r.added; }
      } catch (e) { errors++; }
      done++;
      if (done % 25 === 0 || done === companies.length) {
        console.log(`  ${done}/${companies.length} | companies w/jobs ${withJobs} | jobs added ${totalAdded} | errors ${errors}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`DONE: ${done} companies | ${withJobs} yielded jobs | ${totalAdded} jobs added | ${errors} errors`);
  console.log('added by ATS:', JSON.stringify(byAtsAdded));
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
