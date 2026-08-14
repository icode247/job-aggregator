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
const path = require('path');
const { makePool, q, readProcessed, BATCH_JSON, BATCH_CSV, STATE_DIR } = require('./lib');

// SHARED=1 flips to the companies whose `domain` is a shared ATS host. They have no
// own-domain page to scrape, but each has a unique branded careers page — rendered by
// scripts/logo-review/render-scrape.js. Restricted to the ATS that actually publish a
// per-company logo. (The old note here said Workday career_urls were malformed and DNS
// failed — that was never the real blocker; see WD_BOARD below.)
const SHARED = process.env.SHARED === '1';
// jazzhr and pinpoint were absent with no rationale recorded, unlike workday (malformed
// career_urls) and workable/comeet (vendor art only). A 40-company probe on 2026-08-08 found
// jazzhr 18/18 and pinpoint 7/7 with a unique logo each and no vendor art — 626 companies
// that had never been offered for review. Excluded by the same probe: oraclecloud (0/9 found)
// and lever (3 of 6 served lever-logo-refresh.svg).
// workable added 2026-08-08: the "vendor art only" exclusion predates the headless renderer,
// and a re-probe found 6 of 9 companies serving a distinct per-company logo with no vendor
// art at all. Small sample, so expect the review page to be the real check. Still excluded by
// the same probe: comeet (0 of 36 rendered a logo). Workday was excluded on the same
// evidence — 92 of 102 pages "exposed no logo element" — but that reading was wrong: the
// logo was there and render-scrape was discarding it as vendor art. See WD_BOARD.
const SHARED_ATS = ['paylocity', 'rippling', 'smartrecruiters', 'ashby', 'bamboohr', 'greenhouse', 'grnhse', 'successfactors', 'jazzhr', 'pinpoint', 'workable'];

// WORKDAY=1 reaches Workday companies through the tenant slug rather than the board.
// It was built when Workday boards appeared to expose no logo element — which turned out
// to be render-scrape discarding the tenant logo as vendor art (fixed; see WD_BOARD, which
// is now the better route). This mode still earns its place for companies whose career_url
// has no site path, where the board can't be scraped at all. The way in is the tenant slug:
// career_url is
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
// REDO=ats is the other half of that pool. 1,443 of the favicon stubs were generated from
// the ATS host rather than a company site, so there is no domain to derive — but for the
// ATS that do render a per-company logo (paylocity 945, pinpoint 163, zoho 23,
// smartrecruiters 2) the careers page itself is the target, exactly as in SHARED mode. No
// liveness probe: these hosts are always up. Oracle's 310 stay out — opaque tenant codes,
// and a probe found 0 of 9 rendering anything.
const REDO_ATS = process.env.REDO === 'ats';
// SKIP_ATS_DOMAIN=1 drops companies whose "own domain" is really an ATS-hosted careers
// site (<company>.bamboohr.com). They pass the shared-domain test because the hostname is
// unique per company, but there is no company website behind it — icon-scrape.js refuses
// them, and one 120-company batch came back 100 ATS hosts. Their logos are reachable
// through career_url instead (SHARED / REDO=ats), not through their domain.
const SKIP_ATS_DOMAIN = process.env.SKIP_ATS_DOMAIN === '1';
const ATS_DOMAIN_RE = '(bamboohr|greenhouse|lever|ashbyhq|workable|smartrecruiters|jazzhr|jobvite|icims|myworkdayjobs|myworkdaysite|zohorecruit|recruitee|teamtailor|breezy|personio|comeet|paylocity|rippling|pinpointhq|successfactors|taleo|oraclecloud|applytojob|careerpuck)\\.';
// Some of those favicons were generated from the ATS host rather than the company site.
// Scraping those hands back the vendor art this pass exists to remove.
const ATS_HOSTS = /(paylocity|oraclecloud|myworkdayjobs|myworkdaysite|greenhouse|ashbyhq|lever\.co|icims|zohorecruit|workable|smartrecruiters|bamboohr|jazzhr|comeet|successfactors|taleo|jobvite|breezy|personio|recruitee|teamtailor|pinpointhq)\./i;

// GREENHOUSE=1 targets the Greenhouse job board, which serves a logo the company uploaded
// itself (external_greenhouse_job_boards/logos/...). 4,431 companies already use one, but
// 413 with live jobs still have no logo at all. Scraped by gh-scrape.js, not render-scrape.
const GREENHOUSE = process.env.GREENHOUSE === '1';
// WD_BOARD=1 scrapes the Workday board itself, now that render-scrape no longer discards
// the tenant logo at <tenant>.wdN.myworkdayjobs.com/<Site>/assets/logo as vendor art.
// 4,010 Workday companies have live jobs and no logo; 2,538 have a career_url carrying the
// site path, which is what the logo URL hangs off. The bare-host ones are skipped: without
// a site path the board lands on Workday's outage page.
const WD_BOARD = process.env.WD_BOARD === '1';
// ASHBY=1 re-offers Ashby companies. They were always eligible through SHARED (ashby is in
// SHARED_ATS) and 674 companies already carry an Ashby wordmark, but 174 with live jobs
// still have none — reviewed once, nothing found, retired. The board puts the company's
// uploaded mark at app.ashbyhq.com/api/images/org-theme-wordmark/..., which render-scrape
// picks up (the class carries "wordmark"), so a second pass with its own decided-set is
// worth running.
const ASHBY = process.env.ASHBY === '1';
// COMEET=1 — 386 companies this pipeline recorded as unreachable because career_url is an
// opaque id (comeet.co/jobs/98.008). The id turned out to be half the address: Comeet
// serves the logo at comeet.co/pub/<slug>/<uid>/logo, and the slug comes from the job URL
// or from company_name. Built by comeet-logos.js — no page scrape at all. The batch
// carries one job URL per company, since that is where the slug lives.
const COMEET = process.env.COMEET === '1';
// WORKABLE=1 — 1,235 companies with live jobs and no logo. They were reviewed once through
// SHARED, where the board root (apply.workable.com/<slug>) returns Workable's own
// facebook-preview placeholder for everyone, and retired on that basis. The uploaded mark
// is on the JOB page instead (jobs.workable.com/view/...), server-rendered, so the batch
// carries a job URL per company and workable-logos.js reads it with a plain fetch.
const WORKABLE = process.env.WORKABLE === '1';
// ATS_MODE=recruitee|oracle|breezy — three more pools reachable once you know where each
// one hides the logo. recruitee and oracle are server-rendered and read by ats-logos.js;
// breezy is JS-rendered and goes through render-scrape. oracle covers both the 'oracle'
// and 'oraclecloud' labels, which are the same product under two names in this DB, and
// targets a JOB page because the tenant root does not carry the header.
// SPROUT=1 — any logo-less company, matched by NAME against the Sprout logo CDN. It is
// ATS-agnostic, so it runs across the whole remaining pool rather than one board type.
const SPROUT = process.env.SPROUT === '1';
const ATS_MODE = String(process.env.ATS_MODE || '').toLowerCase();
const ATS_MODES = {
  recruitee: { ats: ['recruitee'], job: false },
  oracle: { ats: ['oracle', 'oraclecloud'], job: true },
  breezy: { ats: ['breezy'], job: false },
};
const ATS_CFG = ATS_MODES[ATS_MODE] || null;
// ats_slug is not trustworthy on its own: some rows hold a path segment from the careers
// URL ("careers", "jobs") rather than a board slug, so prefer the slug in career_url and
// fall back to ats_slug only when it isn't one of those generic words.
const GENERIC_SLUGS = new Set(['careers', 'career', 'jobs', 'job', 'work', 'about', 'company', 'en', 'us']);
function greenhouseSlug(row) {
  const m = String(row.career_url || '').match(/^https?:\/\/(?:job-)?boards\.greenhouse\.io\/([a-z0-9][a-z0-9._-]*)/i);
  if (m) return m[1].replace(/[._-]+$/, '');
  const slug = String(row.ats_slug || '').trim().toLowerCase();
  if (slug && !GENERIC_SLUGS.has(slug) && /^[a-z0-9][a-z0-9._-]*$/.test(slug)) return slug;
  return null;
}

// Scrape the board exactly as the DB records it; build-preview only trusts a join key one
// company claims, so keep one company per board URL.
// The scrape target is only a join key here — comeet-logos.js builds the real URL from
// career_url + slug. Keep one company per career_url so build-preview can join on it.
// Matching is on company_name, so the join key must be unique per company: ids are the
// only thing guaranteed unique here, and build-preview joins on scrape_target.
function buildSproutBatch(rows) {
  const out = rows.slice(0, SIZE);
  for (const r of out) r.scrape_target = `sprout://${r.id}`;
  console.log(`  ${out.length} companies to match by name against the Sprout CDN`);
  return out;
}

function buildComeetBatch(rows) {
  const seen = new Set();
  const out = [];
  let dup = 0;
  for (const r of rows) {
    const url = String(r.career_url).replace(/\/+$/, '');
    if (seen.has(url)) { dup++; continue; }
    seen.add(url);
    r.scrape_target = url;
    out.push(r);
    if (out.length >= SIZE) break;
  }
  console.log(`  ${out.length} comeet boards (skipped ${dup} sharing a career_url)`);
  return out;
}

function buildBoardBatch(rows) {
  const seen = new Set();
  const out = [];
  let dup = 0;
  for (const r of rows) {
    const url = String(r.career_url).replace(/\/+$/, '');
    if (seen.has(url)) { dup++; continue; }
    seen.add(url);
    r.scrape_target = r.career_url = url;
    out.push(r);
    if (out.length >= SIZE) break;
  }
  console.log(`  ${out.length} boards (skipped ${dup} sharing a URL)`);
  return out;
}

function buildGreenhouseBatch(rows) {
  const seen = new Set();
  const out = [];
  let noSlug = 0, dup = 0;
  for (const r of rows) {
    const slug = greenhouseSlug(r);
    if (!slug) { noSlug++; continue; }
    if (seen.has(slug)) { dup++; continue; }
    seen.add(slug);
    r.scrape_target = r.career_url = `https://job-boards.greenhouse.io/${slug}`;
    out.push(r);
    if (out.length >= SIZE) break;
  }
  console.log(`  ${out.length} boards (skipped ${noSlug} with no usable slug, ${dup} sharing one)`);
  return out;
}

const SLUG_ATS = { lever: 'lever', zoho: 'zoho', rippling: 'rippling' };
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
  if (ats === 'rippling') {
    const m = u.match(/^ats\.rippling\.com\/([a-z0-9][a-z0-9._-]*)/);
    if (!m) return null;
    // Boards are often named "<company>-careers" / "<company>-jobs". Those suffixes are
    // about the board, not the company, and derive to domains nobody owns
    // (sterlingcareers.com, androscareers.com). Strip them before guessing a website.
    return m[1].replace(/[._-]*(careers?|jobs?|hiring|talent)$/i, '').replace(/[._-]+$/, '');
  }
  return null;
}

// A slug can spell more than one plausible domain: "mitchell-martin" is both
// mitchellmartin.com and mitchell-martin.com, and which one exists varies by company.
// Offer both and let the liveness probe decide.
function domainCandidates(slug) {
  const flat = slug.replace(/[._-]/g, '');
  const dashed = slug.replace(/[._]/g, '-');
  return [...new Set([flat, dashed])].filter(d => d.length > 2).map(d => `https://${d}.com`);
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

// Hosts already found dead. Only the exported batch gets marked processed, so without this
// every export re-probes the same lapsed domains: one late pass spent 800 probes to find
// 24 live hosts, nearly all of that work repeated from earlier batches. Delete this file to
// re-test everything (a host wrongly cached here is simply never offered again).
const DEAD_HOSTS = path.join(STATE_DIR, 'dead-hosts.txt');
// The companies behind those hosts, so the SQL window can exclude them. Skipping the hosts
// in JS isn't enough: a dead-host company is never marked processed, so it keeps coming
// back and permanently occupies a slot in the window. One export found only 12 new
// candidates in a 1,920-row window because the rest were dead hosts it had already seen.
// Delete this file (and dead-hosts.txt) to re-offer them.
const DEAD_COMPANIES = path.join(STATE_DIR, 'dead-companies.txt');
function readDeadCompanies() {
  if (!fs.existsSync(DEAD_COMPANIES)) return [];
  return fs.readFileSync(DEAD_COMPANIES, 'utf8').split('\n').map(s => Number(s.trim())).filter(Number.isFinite);
}
function readDeadHosts() {
  if (!fs.existsSync(DEAD_HOSTS)) return new Set();
  return new Set(fs.readFileSync(DEAD_HOSTS, 'utf8').split('\n').map(s => s.trim()).filter(Boolean));
}

// Bounded by wall-clock as well as by size. Deep in a pool most candidates are dead, and
// without a deadline the probe phase alone outlives the whole export.
async function filterAlive(rows, size, conc = 20, budgetMs = 240000) {
  const dead = readDeadHosts();
  const skipped = rows.length;
  rows = rows.filter(r => !dead.has(r.scrape_target));
  if (skipped !== rows.length) console.log(`  skipping ${skipped - rows.length} hosts already known dead`);

  const kept = [], newlyDead = [], newlyDeadIds = [];
  const stopAt = Date.now() + budgetMs;
  let next = 0, checked = 0, ranOut = false;
  const worker = async () => {
    while (next < rows.length && kept.length < size) {
      if (Date.now() > stopAt) { ranOut = true; return; }
      const r = rows[next++];
      // Try every spelling of the domain before believing the company has no site.
      const cands = r.candidates && r.candidates.length ? r.candidates : [r.scrape_target];
      let hit = null;
      for (const c of cands) {
        if (dead.has(c)) continue;
        if (await hostIsAlive(c)) { hit = c; break; }
        newlyDead.push(c);
      }
      if (hit) { r.scrape_target = r.career_url = hit; kept.push(r); }
      else newlyDeadIds.push(r.id);
      if (++checked % 50 === 0) console.log(`  probed ${checked}, alive ${kept.length}`);
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  if (newlyDead.length) {
    fs.appendFileSync(DEAD_HOSTS, newlyDead.join('\n') + '\n');
    fs.appendFileSync(DEAD_COMPANIES, newlyDeadIds.join('\n') + '\n');
  }
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
// nothing (one pass probed 300 sites and passed 6). It can't be huge either: every extra
// candidate is another host to probe.
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
// Scrape the careers page itself. build-preview only trusts a join key exactly one company
// claims, so keep one company per career_url.
function buildRedoAtsBatch(rows) {
  const seen = new Set();
  const out = [];
  let dup = 0;
  for (const r of rows) {
    const url = String(r.career_url).replace(/\/+$/, '');
    if (seen.has(url)) { dup++; continue; }
    seen.add(url);
    r.scrape_target = r.career_url = url;
    out.push(r);
    if (out.length >= SIZE) break;
  }
  console.log(`  ${out.length} careers pages (skipped ${dup} sharing a URL)`);
  return out;
}

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
    const cands = SLUG === 'rippling' ? domainCandidates(slug) : [`https://${slug}.com`];
    r.candidates = cands;
    r.scrape_target = r.career_url = cands[0];
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

// The cheap window can't sort by job count, so fill the counts in for the final batch and
// sort here instead — the preview still leads with the biggest boards.
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
    // Dead-host companies are excluded here too, or they clog the window forever.
    const processedIds = [...new Set([...[...processed].map(Number).filter(Number.isFinite), ...readDeadCompanies()])];
    const SLUG_URL_RE = {
      lever: '^https?://jobs\\.lever\\.co/[a-z0-9]',
      zoho: '^https?://[a-z0-9-]+\\.zohorecruit\\.com',
      rippling: '^https?://ats\\.rippling\\.com/[a-z0-9]',
    };
    const fetchWindow = async (limit) => SPROUT
      ? await q(pool, `
          SELECT c.id, c.company_name, c.domain, c.career_url, c.ats, 0 AS jobs
            FROM companies c
           WHERE c.logo_url IS NULL
             AND c.company_name IS NOT NULL AND c.company_name <> ''
             AND NOT (c.id = ANY($2::bigint[]))
             AND EXISTS (SELECT 1 FROM jobs j WHERE j.company_id = c.id AND j.removed_at IS NULL)
           LIMIT $1
        `, [limit, processedIds])
      : ATS_CFG
      ? await q(pool, `
          SELECT c.id, c.company_name, c.domain, c.career_url, c.ats, 0 AS jobs,
                 ${ATS_CFG.job ? `(SELECT j.url FROM jobs j
                     WHERE j.company_id = c.id AND j.removed_at IS NULL LIMIT 1)` : 'NULL'} AS job_url
            FROM companies c
           WHERE c.logo_url IS NULL
             AND c.ats = ANY($3)
             AND c.career_url IS NOT NULL AND c.career_url <> ''
             AND NOT (c.id = ANY($2::bigint[]))
             AND EXISTS (SELECT 1 FROM jobs j WHERE j.company_id = c.id AND j.removed_at IS NULL)
           LIMIT $1
        `, [limit, processedIds, ATS_CFG.ats])
      : WORKABLE
      ? await q(pool, `
          SELECT c.id, c.company_name, c.domain, c.career_url, c.ats, 0 AS jobs,
                 (SELECT j.url FROM jobs j
                   WHERE j.company_id = c.id AND j.removed_at IS NULL AND j.url ILIKE '%jobs.workable.com/view/%'
                   LIMIT 1) AS job_url
            FROM companies c
           WHERE c.logo_url IS NULL
             AND c.ats = 'workable'
             AND NOT (c.id = ANY($2::bigint[]))
             AND EXISTS (SELECT 1 FROM jobs j WHERE j.company_id = c.id AND j.removed_at IS NULL
                          AND j.url ILIKE '%jobs.workable.com/view/%')
           LIMIT $1
        `, [limit, processedIds])
      : COMEET
      ? await q(pool, `
          SELECT c.id, c.company_name, c.domain, c.career_url, c.ats, 0 AS jobs,
                 (SELECT j.url FROM jobs j
                   WHERE j.company_id = c.id AND j.removed_at IS NULL AND j.url ILIKE '%comeet.com/jobs/%'
                   LIMIT 1) AS job_url
            FROM companies c
           WHERE c.logo_url IS NULL
             AND c.ats = 'comeet'
             AND c.career_url ~* 'comeet\\.co/jobs/'
             AND NOT (c.id = ANY($2::bigint[]))
             AND EXISTS (SELECT 1 FROM jobs j WHERE j.company_id = c.id AND j.removed_at IS NULL)
           LIMIT $1
        `, [limit, processedIds])
      : ASHBY
      ? await q(pool, `
          SELECT c.id, c.company_name, c.domain, c.career_url, c.ats, 0 AS jobs
            FROM companies c
           WHERE c.logo_url IS NULL
             AND c.ats = 'ashby'
             AND c.career_url ~* '^https?://jobs\\.ashbyhq\\.com/[a-z0-9]'
             AND NOT (c.id = ANY($2::bigint[]))
             AND EXISTS (SELECT 1 FROM jobs j WHERE j.company_id = c.id AND j.removed_at IS NULL)
           LIMIT $1
        `, [limit, processedIds])
      : WD_BOARD
      ? await q(pool, `
          SELECT c.id, c.company_name, c.domain, c.career_url, c.ats, 0 AS jobs
            FROM companies c
           WHERE c.logo_url IS NULL
             AND c.ats = 'workday'
             AND c.career_url ~* '^https?://[^/]+/.+'
             AND NOT (c.id = ANY($2::bigint[]))
             AND EXISTS (SELECT 1 FROM jobs j WHERE j.company_id = c.id AND j.removed_at IS NULL)
           LIMIT $1
        `, [limit, processedIds])
      : GREENHOUSE
      ? await q(pool, `
          SELECT c.id, c.company_name, c.domain, c.career_url, c.ats, c.ats_slug, 0 AS jobs
            FROM companies c
           WHERE c.logo_url IS NULL
             AND c.ats IN ('greenhouse','grnhse')
             AND NOT (c.id = ANY($2::bigint[]))
             AND EXISTS (SELECT 1 FROM jobs j WHERE j.company_id = c.id AND j.removed_at IS NULL)
           LIMIT $1
        `, [limit, processedIds])
      : REDO_ATS
      ? await q(pool, `
          SELECT c.id, c.company_name, c.domain, c.career_url, c.ats, 0 AS jobs
            FROM companies c
           WHERE c.logo_url ILIKE '%gstatic.com/faviconV2%'
             AND c.ats = ANY($3)
             AND c.career_url IS NOT NULL AND c.career_url <> ''
             AND NOT (c.id = ANY($2::bigint[]))
             AND EXISTS (SELECT 1 FROM jobs j WHERE j.company_id = c.id AND j.removed_at IS NULL)
           LIMIT $1
        `, [limit, processedIds, SHARED_ATS])
      : REDO
      ? await q(pool, `
          SELECT c.id, c.company_name, c.domain, c.career_url, c.ats, 0 AS jobs,
                 substring(c.logo_url from 'url=(https?://[^&]+)') AS favicon_site
            FROM companies c
           WHERE c.logo_url ILIKE '%gstatic.com/faviconV2%'
             AND c.logo_url ~ 'url=https?://[^&]+'
             -- Favicons generated from an ATS host are skipped in JS, but they have to be
             -- excluded here too or they fill the window and hide the reachable ones: a
             -- 1,920-row window surfaced 19 candidates while 218 reachable rows sat behind
             -- 1,443 ATS-host ones.
             AND c.logo_url !~* 'url=https?://[^&]*(paylocity|oraclecloud|myworkdayjobs|myworkdaysite|greenhouse|ashbyhq|lever\.co|icims|zohorecruit|workable|smartrecruiters|bamboohr|jazzhr|comeet|successfactors|taleo|jobvite|breezy|personio|recruitee|teamtailor|pinpointhq)\.'
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
          SELECT c.id, c.company_name, c.domain, c.career_url, c.ats, 0 AS jobs
            FROM companies c
           WHERE c.logo_url IS NULL
             AND c.career_url IS NOT NULL AND c.career_url <> ''
             AND c.ats = ANY($3)
             AND NOT (c.id = ANY($2::bigint[]))
             AND c.domain IN (SELECT domain FROM companies GROUP BY domain HAVING COUNT(*) > 1)
             AND EXISTS (SELECT 1 FROM jobs j WHERE j.company_id = c.id AND j.removed_at IS NULL)
           LIMIT $1
        `, [limit, processedIds, SHARED_ATS])
      : await q(pool, `
          SELECT c.id, c.company_name, c.domain, c.career_url, c.ats, 0 AS jobs
            FROM companies c
           WHERE c.logo_url IS NULL
             AND c.domain IS NOT NULL AND c.domain <> ''
             AND NOT (c.id = ANY($2::bigint[]))
             AND c.domain NOT IN (SELECT domain FROM companies GROUP BY domain HAVING COUNT(*) > 1)
             AND ($3::boolean IS NOT TRUE OR c.domain !~* $4)
             AND EXISTS (SELECT 1 FROM jobs j WHERE j.company_id = c.id AND j.removed_at IS NULL)
           LIMIT $1
        `, [limit, processedIds, SKIP_ATS_DOMAIN, ATS_DOMAIN_RE]);

    let window = WINDOW, rows = [];
    for (;;) {
      ({ rows } = await fetchWindow(window));
      const fresh = rows.filter(r => !processed.has(String(r.id)));
      // Derivation only — no network here. Liveness probing happens after the pool is
      // closed, because probing hundreds of mostly-dead domains takes minutes and Heroku
      // drops the idle connection out from under the next widening query.
      batch = (COMEET || WORKABLE || ATS_CFG) ? buildComeetBatch(fresh) : (WD_BOARD || ASHBY) ? buildBoardBatch(fresh) : GREENHOUSE ? buildGreenhouseBatch(fresh) : REDO_ATS ? buildRedoAtsBatch(fresh) : REDO ? buildRedoBatch(fresh) : DERIVED ? buildSlugBatch(fresh) : fresh.slice(0, SIZE);
      // A short batch is only meaningful if the window wasn't full — otherwise the
      // remainder is simply below the cut.
      if (batch.length >= SIZE || rows.length < window || window >= MAX_WINDOW) break;
      window = Math.min(window * 4, MAX_WINDOW);
      console.log(`  window saturated with reviewed ids, widening to ${window}`);
    }
    // What the scraper is pointed at, and what build-preview joins the results back on.
    // WORKDAY already set both (to the derived company site, not the Workday page).
    // The modes that build their own target (derived domain, careers page, job board) have
    // already set it; only the plain own-domain and SHARED modes need it filled in here.
    if (!DERIVED && !REDO_ATS && !GREENHOUSE && !WD_BOARD && !ASHBY && !COMEET && !WORKABLE && !ATS_CFG && !SPROUT) for (const r of batch) r.scrape_target = SHARED ? r.career_url : r.domain;
    scanned = rows.length;
  } finally {
    await pool.end();
  }

  // Everything below runs with no DB connection open.
  if (!DERIVED && !REDO_ATS && batch.length) {
    // Same reason as the derived modes: aggregating job counts over the whole window is
    // what made this query cost two minutes a call. Count the final slice instead.
    const pool2 = makePool();
    try { await attachJobCounts(pool2, batch); } finally { await pool2.end(); }
  }
  if ((REDO_ATS || GREENHOUSE || WD_BOARD || ASHBY || COMEET || WORKABLE || ATS_CFG || SPROUT) && batch.length) {
    const pool2 = makePool();
    try { await attachJobCounts(pool2, batch); } finally { await pool2.end(); }
  }
  if (DERIVED && batch.length) {
    console.log(`  probing which of ${batch.length} derived domains resolve`);
    batch = await filterAlive(batch, SIZE);
    // Counts come AFTER the probe, on the survivors only. Counting live jobs per company
    // across the 23GB jobs table costs 547s for 1,920 ids and 2s for 120 — doing it up
    // front, to order candidates by impact, was quietly the most expensive step in the
    // export. The dead-host cache makes probe order cheap to get wrong, so it isn't worth
    // paying for.
    if (batch.length) {
      const pool2 = makePool();
      try { await attachJobCounts(pool2, batch); } finally { await pool2.end(); }
    }
  }
  if (!batch.length) {
    console.log(`EXPORTED 0 — queue is genuinely empty (scanned ${scanned} rows, all reviewed)`);
    // Exit non-zero so a chained run stops here. Otherwise the scrape and preview steps
    // happily rebuild the PREVIOUS batch — the files are all still on disk — and hand back
    // a preview that looks new but re-offers companies already saved and retired.
    process.exit(3);
  }

  fs.writeFileSync(BATCH_JSON, JSON.stringify(batch, null, 2));
  fs.writeFileSync(BATCH_CSV, 'website\n' + batch.map(r => r.scrape_target).join('\n') + '\n');
  console.log(`EXPORTED ${batch.length} (jobs ${batch[0].jobs} -> ${batch[batch.length - 1].jobs})`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
