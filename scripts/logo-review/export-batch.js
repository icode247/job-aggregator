#!/usr/bin/env node
/**
 * Export the next batch of logo-less companies for review.
 *
 *   node scripts/logo-review/export-batch.js [size]        # default 500
 *
 * Picks companies with no logo, ordered by live job count (highest user-visible
 * impact first), skipping anything already reviewed (data/logo/processed.txt).
 * Writes data/logo/batch-companies.json + batch-websites.csv (scraper input).
 */
const fs = require('fs');
const { makePool, q, readProcessed, BATCH_JSON, BATCH_CSV } = require('./lib');

// SHARED=1 flips to the companies whose `domain` is a shared ATS host. They have no
// own-domain page to scrape, but each has a unique branded careers page — rendered by
// scripts/logo-review/render-scrape.js. Restricted to the ATS that actually publish a
// per-company logo: Workday career_urls in the DB are malformed (missing the wdN
// subdomain, so DNS fails) and Workable/Comeet boards only ever show vendor art.
const SHARED = process.env.SHARED === '1';
// jazzhr and pinpoint were absent with no rationale recorded, unlike workday (malformed
// career_urls) and workable/comeet (vendor art only). A 40-company probe on 2026-08-08 found
// jazzhr 18/18 and pinpoint 7/7 with a unique logo each and no vendor art — 626 companies
// that had never been offered for review. Excluded by the same probe: oraclecloud (0/9 found)
// and lever (3 of 6 served lever-logo-refresh.svg).
// workable added 2026-08-08: the "vendor art only" exclusion predates the headless renderer,
// and a re-probe found 6 of 9 companies serving a distinct per-company logo with no vendor
// art at all. Small sample, so expect the review page to be the real check. Still excluded by
// the same probe: comeet (0 of 36 rendered a logo) and workday — 92 of 102 pages loaded fine
// but expose no logo element, so the documented DNS rationale was never the real blocker.
const SHARED_ATS = ['paylocity', 'rippling', 'smartrecruiters', 'ashby', 'bamboohr', 'greenhouse', 'grnhse', 'successfactors', 'jazzhr', 'pinpoint', 'workable'];

// WORKDAY=1 is a third mode, for the largest logo-less bucket left: 3,271 companies /
// 413k live jobs. Scraping the Workday page itself is a dead end — a probe found 92 of
// 102 pages load fine but expose no logo element at all, which is why every earlier pass
// returned "no candidate". The way in is the tenant slug: career_url is
// https://<tenant>.myworkdayjobs.com, and the tenant is almost always the company's real
// identity (cvshealth, dollartree, pwc, micron). So derive <tenant>.com and scrape the
// company's OWN website, where the logo actually lives.
const WORKDAY = process.env.WORKDAY === '1';
// Tenants that are an HR-department name rather than a company name. <slug>.com for these
// belongs to somebody else entirely (globalhr.com is not Collins Aerospace), and a
// plausible-looking wrong logo is exactly what the eyeball step is worst at catching.
const GENERIC_TENANTS = new Set([
  'globalhr', 'hr', 'hcm', 'careers', 'career', 'jobs', 'myjobs', 'job', 'corp', 'corporate',
  'external', 'recruiting', 'recruitment', 'talent', 'people', 'workday', 'wd1', 'wd3', 'wd5',
  'employment', 'hiring', 'apply', 'candidate', 'staffing', 'inc', 'group', 'holdings',
]);

// A derived host is a guess. Only ship the ones that answer, because save-logos.js marks
// the whole batch processed: a company skipped merely for being .org instead of .com would
// be burned permanently, having never been looked at. Non-responders are simply left in
// the queue for a better derivation later.
async function hostIsAlive(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    // Any HTTP answer counts, including 403 — the big retail sites bot-block a bare HEAD
    // but render fine in the headless browser that does the actual scraping.
    await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function filterAlive(rows, size, conc = 20) {
  const kept = [];
  let next = 0, checked = 0;
  const worker = async () => {
    while (next < rows.length && kept.length < size) {
      const r = rows[next++];
      if (await hostIsAlive(r.scrape_target)) kept.push(r);
      if (++checked % 50 === 0) console.log(`  probed ${checked}, alive ${kept.length}`);
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  return kept.slice(0, size);
}

const SIZE = parseInt(process.argv[2] || '500', 10);
// Pull a wide window so the already-reviewed ids can be filtered out in JS and we
// still land a full batch. The window is ordered by job count, so once enough of the
// high-job companies have been reviewed it fills up entirely with processed ids and
// returns a near-empty batch while thousands of unreviewed ones sit further down the
// tail — indistinguishable from a genuinely empty queue. Widen until the batch fills
// or the query stops returning a full window (which means we have seen everything).
const WINDOW = Math.max(8000, SIZE * 16);
const MAX_WINDOW = 200000;

// Turn Workday rows into a batch pointed at each company's own website. Two companies can
// share a tenant (subsidiaries under one parent, e.g. Caremark under cvshealth), and
// build-preview only trusts a join key exactly one company claims — so keep the highest
// job-count company per tenant and leave the siblings for a later pass rather than
// exporting rows the preview would silently drop.
// Workday publishes tenants under three URL shapes and the tenant sits in a different
// place in each. Missing the last two would have left ~1,500 of the largest companies
// (campingworld, hpe, genpact, verisure) unreachable.
function workdayTenant(careerUrl) {
  const u = String(careerUrl || '').replace(/^https?:\/\//i, '').toLowerCase();
  // <tenant>.myworkdayjobs.com and <tenant>.wdN.myworkdayjobs.com
  const host = u.split('/')[0];
  const jobs = host.match(/^([a-z0-9-]+)\.(?:wd\d+\.)?myworkdayjobs\.com$/);
  if (jobs) return jobs[1];
  // wdN.myworkdaysite.com/recruiting/<tenant> — the host is just a datacentre number, so
  // the tenant has to come from the path. Some rows stop at /recruiting with no tenant.
  const site = u.match(/^wd\d+\.myworkdaysite\.com\/recruiting\/([a-z0-9-]+)/);
  if (site) return site[1];
  return null;
}

function buildWorkdayBatch(rows) {
  const seen = new Set();
  const candidates = [];
  let generic = 0, dup = 0;
  for (const r of rows) {
    const slug = workdayTenant(r.career_url);
    if (!slug || GENERIC_TENANTS.has(slug)) { generic++; continue; }
    if (seen.has(slug)) { dup++; continue; }
    seen.add(slug);
    r.tenant = slug;
    r.scrape_target = r.career_url = `https://${slug}.com`;
    candidates.push(r);
  }
  console.log(`  ${candidates.length} tenants (skipped ${generic} generic, ${dup} sharing a tenant)`);
  return candidates;
}

async function main() {
  const pool = makePool();
  let batch = [], scanned = 0;
  try {
    const processed = readProcessed();
    // Skip companies whose `domain` is a shared ATS host (recruiting.paylocity.com,
    // apply.workable.com, boards.greenhouse.io, ...). Scraping those returns the ATS's
    // own branding, so every company behind one host gets handed the same wrong image.
    // ~23.6k of the logo-less pool sits here and needs real-website discovery instead.
    const fetchWindow = async (limit) => WORKDAY
      ? await q(pool, `
          SELECT c.id, c.company_name, c.domain, c.career_url, c.ats, COUNT(j.id)::int AS jobs
            FROM companies c
            JOIN jobs j ON j.company_id = c.id AND j.removed_at IS NULL
           WHERE c.logo_url IS NULL
             AND c.ats = 'workday'
             AND c.career_url ~* '^https?://([a-z0-9-]+\\.(wd[0-9]+\\.)?myworkdayjobs\\.com|wd[0-9]+\\.myworkdaysite\\.com/recruiting/[a-z0-9-]+)'
           GROUP BY c.id
           ORDER BY jobs DESC
           LIMIT $1
        `, [limit])
      : SHARED
      ? await q(pool, `
          SELECT c.id, c.company_name, c.domain, c.career_url, c.ats, COUNT(j.id)::int AS jobs
            FROM companies c
            JOIN jobs j ON j.company_id = c.id AND j.removed_at IS NULL
           WHERE c.logo_url IS NULL
             AND c.career_url IS NOT NULL AND c.career_url <> ''
             AND c.ats = ANY($2)
             AND c.domain IN (SELECT domain FROM companies GROUP BY domain HAVING COUNT(*) > 1)
           GROUP BY c.id
           ORDER BY jobs DESC
           LIMIT $1
        `, [limit, SHARED_ATS])
      : await q(pool, `
          SELECT c.id, c.company_name, c.domain, c.career_url, c.ats, COUNT(j.id)::int AS jobs
            FROM companies c
            JOIN jobs j ON j.company_id = c.id AND j.removed_at IS NULL
           WHERE c.logo_url IS NULL
             AND c.domain IS NOT NULL AND c.domain <> ''
             AND c.domain NOT IN (SELECT domain FROM companies GROUP BY domain HAVING COUNT(*) > 1)
           GROUP BY c.id
           ORDER BY jobs DESC
           LIMIT $1
        `, [limit]);

    let window = WINDOW, rows = [];
    for (;;) {
      ({ rows } = await fetchWindow(window));
      const fresh = rows.filter(r => !processed.has(String(r.id)));
      // Derivation only — no network here. Liveness probing happens after the pool is
      // closed, because probing hundreds of mostly-dead domains takes minutes and Heroku
      // drops the idle connection out from under the next widening query.
      batch = WORKDAY ? buildWorkdayBatch(fresh) : fresh.slice(0, SIZE);
      // A short batch is only meaningful if the window wasn't full — otherwise the
      // remainder is simply below the cut.
      if (batch.length >= SIZE || rows.length < window || window >= MAX_WINDOW) break;
      window = Math.min(window * 4, MAX_WINDOW);
      console.log(`  window saturated with reviewed ids, widening to ${window}`);
    }
    // What the scraper is pointed at, and what build-preview joins the results back on.
    // WORKDAY already set both (to the derived company site, not the Workday page).
    if (!WORKDAY) for (const r of batch) r.scrape_target = SHARED ? r.career_url : r.domain;
    scanned = rows.length;
  } finally {
    await pool.end();
  }

  // Everything below runs with no DB connection open.
  if (WORKDAY && batch.length) {
    console.log(`  probing which of ${batch.length} derived domains resolve`);
    batch = await filterAlive(batch, SIZE);
  }
  if (!batch.length) {
    console.log(`EXPORTED 0 — queue is genuinely empty (scanned ${scanned} rows, all reviewed)`);
    return;
  }

  fs.writeFileSync(BATCH_JSON, JSON.stringify(batch, null, 2));
  fs.writeFileSync(BATCH_CSV, 'website\n' + batch.map(r => r.scrape_target).join('\n') + '\n');
  console.log(`EXPORTED ${batch.length} (jobs ${batch[0].jobs} -> ${batch[batch.length - 1].jobs})`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
