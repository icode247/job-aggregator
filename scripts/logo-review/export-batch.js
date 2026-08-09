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

// SLUG=lever|zoho applies the same derive-the-company's-own-site trick to the two other
// ATS whose URL carries a real company slug: jobs.lever.co/<slug> and
// <slug>.zohorecruit.com. Comeet (comeet.co/jobs/51.00F) and OracleCloud
// (elyb.fa.us2.oraclecloud.com) carry opaque ids instead and cannot be reached this way at
// any effort, so they are not offered here.
//
// The signal is weaker than Workday's. Lever and Zoho slugs are short and generic
// (citcon, apexaba, supportspeedy) where Workday tenants were corporate (cvshealth,
// thermofisher), so <slug>.com collides with an unrelated business far more often. The
// extra guard is nameLooksRelated(): a card whose slug does not resemble the company name
// still gets shown, but is NOT pre-checked, so the reviewer has to opt in rather than
// opt out.

// REDO=1 re-reviews companies that already have a logo_url which isn't a logo. 6,680
// companies (5,677 with live jobs) carry a Google favicon-proxy URL — a 128px site icon,
// not company art — set by some earlier process. export-batch only ever looks at
// logo_url IS NULL, so they could never come back for review on their own.
//
// The favicon URL embeds the site it was generated from (...&url=https://mattelinc.com),
// which is a better scrape target than anything we could derive: all 5,677 carry one. Run
// this pass with its own decided-set so it stays out of the main queue:
//   PROCESSED_FILE=data/logo/processed-redo.txt REDO=1 node .../export-batch.js 130
const REDO = process.env.REDO === '1';
// Some of those favicons were generated from the ATS host rather than the company site.
// Scraping those hands back the vendor art this pass exists to remove.
const ATS_HOSTS = /(paylocity|oraclecloud|myworkdayjobs|myworkdaysite|greenhouse|ashbyhq|lever\.co|icims|zohorecruit|workable|smartrecruiters|bamboohr|jazzhr|comeet|successfactors|taleo|jobvite|breezy|personio|recruitee|teamtailor|pinpointhq)\./i;

const SLUG_ATS = { lever: 'lever', zoho: 'zoho' };
const SLUG = SLUG_ATS[String(process.env.SLUG || '').toLowerCase()] || null;
// The modes that scrape the company's own site rather than the ATS page, and so need the
// liveness probe and the after-the-fact job counts.
const DERIVED = WORKDAY || !!SLUG || REDO;

function slugFor(ats, careerUrl) {
  const u = String(careerUrl || '').replace(/^https?:\/\//i, '').toLowerCase();
  if (ats === 'lever') {
    const m = u.match(/^jobs\.lever\.co\/([a-z0-9][a-z0-9._-]*)/);
    return m ? m[1].replace(/[._-]+$/, '') : null;
  }
  if (ats === 'zoho') {
    const m = u.match(/^([a-z0-9-]+)\.zohorecruit\.com/);
    return m ? m[1] : null;
  }
  return null;
}

// Does the slug plausibly belong to this company? Compares letters-only forms both ways,
// so "citcon" matches "Citcon" and "apexaba" matches "Apex ABA Therapy", while a slug that
// shares nothing with the name is treated as unverified.
function nameLooksRelated(slug, companyName) {
  const a = String(slug || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const b = String(companyName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!a || !b) return false;
  if (b.startsWith(a) || a.startsWith(b) || b.includes(a)) return true;
  // Or the slug is the company's initials/first words run together.
  const words = String(companyName || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.length > 1 && a === words.map(w => w[0]).join('');
}

// A derived host is a guess. Only ship the ones that answer, because save-logos.js marks
// the whole batch processed: a company skipped merely for being .org instead of .com would
// be burned permanently, having never been looked at. Non-responders are simply left in
// the queue for a better derivation later.
// A timeout is not evidence a domain is dead — it is usually evidence we asked too hard.
// Probing at concurrency 40 with a 6s deadline (while six crawler instances shared the
// link) timed out nearly every live host: the alive rate fell from 30-50% to 2%, and
// citcon.com / topdesk.com / poki.com were all reported dead while answering fine to a
// plain curl. Since a host judged dead means a company withheld from review, be patient
// and retry an aborted probe once before believing it.
async function probeOnce(url, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    // Any HTTP answer counts, including 403 — the big retail sites bot-block a bare HEAD
    // but render fine in the headless browser that does the actual scraping.
    await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctl.signal });
    return 'alive';
  } catch (err) {
    // A DNS/TLS/connection-refused failure is a real answer; an abort is only impatience.
    return err.name === 'AbortError' ? 'timeout' : 'failed';
  } finally {
    clearTimeout(timer);
  }
}

// Retry every kind of failure, not just timeouts. A DNS error looks definitive but isn't:
// the resolver here is a home router shared with six crawler instances, and it drops
// queries under load — mid-run it briefly failed to resolve even the Heroku database host,
// which resolved fine a moment later. Treating that as "domain is dead" silently withheld
// companies from review (one batch probed 400 sites and passed 19).
async function hostIsAlive(url) {
  const first = await probeOnce(url, 10000);
  if (first === 'alive') return true;
  // The retry exists to survive a flaky resolver, and a transient failure clears quickly —
  // so keep it short. A generous retry made every dead domain cost 35s, and once the pool's
  // dead fraction rose the export stopped finishing at all.
  await new Promise(r => setTimeout(r, 500));
  return (await probeOnce(url, 8000)) === 'alive';
}

// Bounded by wall-clock as well as by size. Deep in a pool most candidates are dead, and
// without a deadline the probe phase alone outlives the whole export.
async function filterAlive(rows, size, conc = 20, budgetMs = 240000) {
  const kept = [];
  const stopAt = Date.now() + budgetMs;
  let next = 0, checked = 0, ranOut = false;
  const worker = async () => {
    while (next < rows.length && kept.length < size) {
      if (Date.now() > stopAt) { ranOut = true; return; }
      const r = rows[next++];
      if (await hostIsAlive(r.scrape_target)) kept.push(r);
      if (++checked % 50 === 0) console.log(`  probed ${checked}, alive ${kept.length}`);
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  if (ranOut) console.log(`  probe budget spent after ${checked} of ${rows.length} candidates — shipping ${Math.min(kept.length, size)}`);
  return kept.slice(0, size);
}

const SIZE = parseInt(process.argv[2] || '500', 10);
// Pull a wide window so the already-reviewed ids can be filtered out in JS and we
// still land a full batch. The window is ordered by job count, so once enough of the
// high-job companies have been reviewed it fills up entirely with processed ids and
// returns a near-empty batch while thousands of unreviewed ones sit further down the
// tail — indistinguishable from a genuinely empty queue. Widen until the batch fills
// or the query stops returning a full window (which means we have seen everything).
// REDO pulls from a pool where every row is equally in need of review, so there is nothing
// to prioritise — but the window still can't be tiny. Rows come back in physical order, so
// a narrow one lands entirely inside a cluster of lapsed domains and returns almost
// nothing (one pass probed 300 sites and passed 6). It can't be huge either: attachJobCounts
// aggregates over every candidate, and a 7,000-id window made the export never finish.
const WINDOW = REDO ? SIZE * 16 : Math.max(8000, SIZE * 16);
const MAX_WINDOW = 200000;

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

// Turn Workday rows into a batch pointed at each company's own website. Two companies can
// share a tenant (subsidiaries under one parent, e.g. Caremark under cvshealth), and
// build-preview only trusts a join key exactly one company claims — so keep the highest
// job-count company per tenant and leave the siblings for a later pass rather than
// exporting rows the preview would silently drop.
// Point the scraper at the site the favicon was generated from. No slug guessing here, so
// no name check is needed — the URL names the site directly.
function buildRedoBatch(rows) {
  const seen = new Set();
  const candidates = [];
  let atsHost = 0, dup = 0;
  for (const r of rows) {
    const site = String(r.favicon_site || '').replace(/\/+$/, '');
    if (!site || ATS_HOSTS.test(site)) { atsHost++; continue; }
    // build-preview only trusts a join key exactly one company claims.
    if (seen.has(site)) { dup++; continue; }
    seen.add(site);
    r.scrape_target = r.career_url = site;
    candidates.push(r);
  }
  console.log(`  ${candidates.length} favicon sites (skipped ${atsHost} pointing back at an ATS host, ${dup} duplicate sites)`);
  return candidates;
}

function buildSlugBatch(rows) {
  const seen = new Set();
  const candidates = [];
  let generic = 0, dup = 0, unverified = 0;
  for (const r of rows) {
    const slug = WORKDAY ? workdayTenant(r.career_url) : slugFor(SLUG, r.career_url);
    if (!slug || GENERIC_TENANTS.has(slug) || slug.length < 3) { generic++; continue; }
    if (seen.has(slug)) { dup++; continue; }
    seen.add(slug);
    r.tenant = slug;
    r.scrape_target = r.career_url = `https://${slug}.com`;
    // Workday tenants are corporate and reliable; the Lever/Zoho slugs are the ones that
    // need the name check, so only they can come back unverified.
    r.slug_match = WORKDAY ? true : nameLooksRelated(slug, r.company_name);
    if (!r.slug_match) unverified++;
    candidates.push(r);
  }
  const tail = WORKDAY ? '' : `, ${unverified} name-unverified (shown but not pre-checked)`;
  console.log(`  ${candidates.length} slugs (skipped ${generic} generic, ${dup} sharing a slug${tail})`);
  return candidates;
}

// The cheap window can't sort by job count, so fill the counts in for the derived
// candidates and sort here instead. Counting jobs for a known id list is trivial next to
// aggregating the whole logo-less Workday pool, and probing in impact order matters: an
// unordered window handed back companies with 1-15 jobs, whose tenant slugs almost never
// resolve to a real .com, so 1,000 probes yielded 8 live domains.
async function attachJobCounts(pool, batch) {
  const { rows } = await q(pool, `
    SELECT company_id, COUNT(*)::int AS jobs
      FROM jobs WHERE removed_at IS NULL AND company_id = ANY($1::bigint[])
     GROUP BY company_id`, [batch.map(r => Number(r.id))]);
  const counts = new Map(rows.map(r => [String(r.company_id), r.jobs]));
  for (const r of batch) r.jobs = counts.get(String(r.id)) || 0;
  batch.sort((a, b) => b.jobs - a.jobs);
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
    // The Workday window deliberately avoids JOIN + GROUP BY + ORDER BY COUNT(*), which
    // measured 119s against 4.5s for the EXISTS form on the same predicate — and the
    // widening loop runs it up to four times, which is what pushed the export past every
    // timeout it was run under. Reviewed ids are excluded in SQL rather than in JS, so the
    // window can't saturate with them and no widening is needed. Job counts are attached
    // afterwards, for the ~SIZE survivors only.
    const processedIds = [...processed].map(Number).filter(Number.isFinite);
    const SLUG_URL_RE = {
      lever: '^https?://jobs\\.lever\\.co/[a-z0-9]',
      zoho: '^https?://[a-z0-9-]+\\.zohorecruit\\.com',
    };
    const fetchWindow = async (limit) => REDO
      ? await q(pool, `
          SELECT c.id, c.company_name, c.domain, c.career_url, c.ats, 0 AS jobs,
                 substring(c.logo_url from 'url=(https?://[^&]+)') AS favicon_site
            FROM companies c
           WHERE c.logo_url ILIKE '%gstatic.com/faviconV2%'
             AND c.logo_url ~ 'url=https?://[^&]+'
             AND NOT (c.id = ANY($2::bigint[]))
             AND EXISTS (SELECT 1 FROM jobs j WHERE j.company_id = c.id AND j.removed_at IS NULL)
           LIMIT $1
        `, [limit, processedIds])
      : WORKDAY
      ? await q(pool, `
          SELECT c.id, c.company_name, c.domain, c.career_url, c.ats, 0 AS jobs
            FROM companies c
           WHERE c.logo_url IS NULL
             AND c.ats = 'workday'
             AND c.career_url ~* '^https?://([a-z0-9-]+\\.(wd[0-9]+\\.)?myworkdayjobs\\.com|wd[0-9]+\\.myworkdaysite\\.com/recruiting/[a-z0-9-]+)'
             AND NOT (c.id = ANY($2::bigint[]))
             AND EXISTS (SELECT 1 FROM jobs j WHERE j.company_id = c.id AND j.removed_at IS NULL)
           LIMIT $1
        `, [limit, processedIds])
      : SLUG
      ? await q(pool, `
          SELECT c.id, c.company_name, c.domain, c.career_url, c.ats, 0 AS jobs
            FROM companies c
           WHERE c.logo_url IS NULL
             AND c.ats = $3
             AND c.career_url ~* $4
             AND NOT (c.id = ANY($2::bigint[]))
             AND EXISTS (SELECT 1 FROM jobs j WHERE j.company_id = c.id AND j.removed_at IS NULL)
           LIMIT $1
        `, [limit, processedIds, SLUG, SLUG_URL_RE[SLUG]])
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
      batch = REDO ? buildRedoBatch(fresh) : DERIVED ? buildSlugBatch(fresh) : fresh.slice(0, SIZE);
      // A short batch is only meaningful if the window wasn't full — otherwise the
      // remainder is simply below the cut.
      if (batch.length >= SIZE || rows.length < window || window >= MAX_WINDOW) break;
      window = Math.min(window * 4, MAX_WINDOW);
      console.log(`  window saturated with reviewed ids, widening to ${window}`);
    }
    // What the scraper is pointed at, and what build-preview joins the results back on.
    // WORKDAY already set both (to the derived company site, not the Workday page).
    if (!DERIVED) for (const r of batch) r.scrape_target = SHARED ? r.career_url : r.domain;
    // Order the candidates by impact while the connection is still open — probing happens
    // after the pool closes and must not be the thing holding it.
    if (DERIVED && batch.length) await attachJobCounts(pool, batch);
    scanned = rows.length;
  } finally {
    await pool.end();
  }

  // Everything below runs with no DB connection open.
  if (DERIVED && batch.length) {
    console.log(`  probing which of ${batch.length} derived domains resolve (biggest first)`);
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
