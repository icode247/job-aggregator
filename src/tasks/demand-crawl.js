#!/usr/bin/env node
/**
 * Phase 2 — demand-driven crawling (multi-source).
 *
 * Reads the top UNMET demand from search_demand (searched a lot, few results — the
 * unsatisfied customers Phase 0 surfaced), splits the OR-lists into (title × location)
 * queries, and fetches those exact jobs from every ENABLED source, upserting into Postgres.
 *
 * Sources:
 *   liftmycv    — always on (public keyword+location API, free). Biggest catalog.
 *   wonsulting  — on when WONSULTING_COOKIE is set (long-lived ~2y browser cookie). Free.
 *   googlejobs  — on when GOOGLE_JOBS=1 AND SCRAPINGDOG_KEY set. PAID per request — hard
 *                 capped by GOOGLE_JOBS_MAX_REQ per process run; keep it low. Opt-in.
 *
 * Jobs are stored per-source (company keyed by career_url, external_id = source job id) so
 * they merge with existing rows rather than duplicating. origin = demand_<source>.
 *
 * Run:  DATABASE_URL=... node src/tasks/demand-crawl.js          # one drain of due demand
 *       DATABASE_URL=... LOOP=1 node src/tasks/demand-crawl.js   # keep re-checking
 *       DATABASE_URL=... DRY=1 node src/tasks/demand-crawl.js    # fetch+map, write nothing
 * Env:  DEMAND_MAX_RESULTS(10) DEMAND_BATCH(15) DEMAND_RECRAWL_HOURS(6)
 *       DEMAND_MAX_TITLES(3) DEMAND_MAX_LOCATIONS(2) DEMAND_PAGES(1) DEMAND_PAGE_SIZE(100)
 *       DEMAND_DELAY_MS(1200) RECHECK_S(600)
 *       WONSULTING_COOKIE  GOOGLE_JOBS(0) SCRAPINGDOG_KEY GOOGLE_JOBS_MAX_REQ(40)
 */
// Load .env at repo root so the always-on fleet picks up WONSULTING_COOKIE / SCRAPINGDOG_KEY /
// SERPER_API_KEY without them being exported in the shell. Real env vars take precedence.
(function loadEnv() {
  try {
    const fs = require('fs'), path = require('path');
    fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8').split(/\r?\n/).forEach((l) => {
      const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch { /* no .env — rely on real env */ }
})();
const https = require('https');
const { query, closeDb } = require('../db/connection');
const logger = require('../logger');
const { classifyJob } = require('../utils/classify');

const THRESHOLD = parseInt(process.env.DEMAND_MAX_RESULTS || '10', 10);
const BATCH = parseInt(process.env.DEMAND_BATCH || '25', 10);
// 48h (not 6h): a just-crawled demand shouldn't be redone for days, or the top few high-volume
// searches get re-crawled every cycle and the long-tail backlog never gets reached.
const RECRAWL_HOURS = parseInt(process.env.DEMAND_RECRAWL_HOURS || '48', 10);
const MAX_TITLES = parseInt(process.env.DEMAND_MAX_TITLES || '3', 10);
const MAX_LOCATIONS = parseInt(process.env.DEMAND_MAX_LOCATIONS || '2', 10);
const PAGES = parseInt(process.env.DEMAND_PAGES || '1', 10);
const PAGE_SIZE = parseInt(process.env.DEMAND_PAGE_SIZE || '100', 10);
const DELAY_MS = parseInt(process.env.DEMAND_DELAY_MS || '1200', 10);
const LOOP = process.env.LOOP === '1';
const DRY = process.env.DRY === '1';
const RECHECK_S = parseInt(process.env.RECHECK_S || '600', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- HTTP helpers ----------
function httpGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 25000, headers }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(`JSON parse: ${e.message}`)); } });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}
function httpPostJson(hostname, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({ hostname, path, method: 'POST', timeout: 45000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d || '{}') }); } catch { resolve({ status: res.statusCode, json: {} }); } });
    });
    req.on('error', reject); req.on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
    req.write(payload); req.end();
  });
}

// ---------- shared company derivation (canonical career_url + ats + slug per employer) ----------
const ATS_HOST_MAP = { greenhouse: 'greenhouse', lever: 'lever', ashby: 'ashby', workable: 'workable',
  bamboohr: 'bamboohr', smartrecruiters: 'smartrecruiters', recruitee: 'recruitee', breezy: 'breezy',
  personio: 'personio', pinpoint: 'pinpoint', jazzhr: 'jazzhr', rippling: 'rippling', zoho: 'zoho' };

function deriveCompany(applyUrl, atsHint, companyName, sourceName) {
  const strip = (u) => { try { const x = new URL(u); ['userid','jobid','utm_source','utm_medium','utm_campaign','gh_src'].forEach(p => x.searchParams.delete(p)); return x.toString().replace(/\?$/, ''); } catch { return u; } };
  const clean = strip(applyUrl || '');
  let host = '', parts = [], proto = 'https:';
  try { const u = new URL(clean); host = u.hostname.toLowerCase().replace(/^www\./, ''); parts = u.pathname.split('/').filter(Boolean); proto = u.protocol; } catch {}
  const sub = host.split('.')[0];
  let ats = (atsHint || '').toLowerCase() || null, slug = null, careerUrl = null;
  // Subdomain-tenant ATS (tenant lives in the hostname)
  if (host.endsWith('.myworkdayjobs.com')) { ats = 'workday'; slug = sub; careerUrl = `https://${sub}.myworkdayjobs.com`; }
  else if (host.endsWith('.icims.com')) { ats = 'icims'; slug = sub; careerUrl = `https://${sub}.icims.com`; }
  else if (host.endsWith('.bamboohr.com')) { ats = 'bamboohr'; slug = sub; careerUrl = `https://${sub}.bamboohr.com`; }
  else if (host.endsWith('.recruitee.com')) { ats = 'recruitee'; slug = sub; careerUrl = `https://${sub}.recruitee.com`; }
  else if (host.endsWith('.breezy.hr')) { ats = 'breezy'; slug = sub; careerUrl = `https://${sub}.breezy.hr`; }
  else if (host.includes('teamtailor.com') && sub !== 'teamtailor') { ats = 'teamtailor'; slug = sub; careerUrl = `https://${sub}.teamtailor.com`; }
  // Path-slug ATS (boards.greenhouse.io/{slug}, jobs.lever.co/{slug}, ...)
  else if (parts[0] && /greenhouse|lever|ashby|workable|smartrecruiters/.test(host)) {
    slug = parts[0];
    if (host.includes('greenhouse')) { ats = 'greenhouse'; careerUrl = `https://boards.greenhouse.io/${slug}`; }
    else if (host.includes('lever')) { ats = 'lever'; careerUrl = `https://jobs.lever.co/${slug}`; }
    else if (host.includes('ashby')) { ats = 'ashby'; careerUrl = `https://jobs.ashbyhq.com/${slug}`; }
    else if (host.includes('workable')) { ats = 'workable'; careerUrl = `https://apply.workable.com/${slug}`; }
    else if (host.includes('smartrecruiters')) { ats = 'smartrecruiters'; careerUrl = `https://jobs.smartrecruiters.com/${slug}`; }
  }
  // Generic fallback: host root, else namespace by company name so it still stores.
  if (!careerUrl) {
    if (host && parts[0]) { slug = parts[0]; careerUrl = `${proto}//${host}/${slug}`; }
    else if (host) { slug = sub; careerUrl = `${proto}//${host}`; }
    else { slug = (companyName || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); careerUrl = `${sourceName}://${slug}`; }
    ats = ats || ATS_HOST_MAP[sub] || sourceName;
  }
  let domain; try { domain = new URL(careerUrl).hostname; } catch { domain = slug; }
  return { ats: ats || sourceName, slug, careerUrl, domain };
}

// ---------- sources: each returns an array of NORMALIZED jobs ----------
// normalized = { externalId, source, atsHint, company, applyUrl, title, location, description, postedAt, workplaceType }
function wp(v) { const w = String(v || '').toUpperCase(); if (w === 'REMOTE') return 'remote'; if (w === 'HYBRID') return 'hybrid'; if (w === 'ONSITE' || w === 'ON_SITE') return 'onsite'; return null; }

const liftmycv = {
  name: 'liftmycv',
  enabled: () => true,
  async search(title, location, page) {
    const p = new URLSearchParams({ roles: title, count: String(PAGE_SIZE), page: String(page) });
    if (location) p.set('location', location);
    const data = await httpGetJson(`https://app.liftmycv.com/api/v1/jobs/search?${p}`);
    return (data?.results?.jobs || []).map((j) => ({
      externalId: j.id, source: 'liftmycv', atsHint: j.platform, company: j.company, applyUrl: j.companyUrl,
      title: j.role, location: j.location, description: j.description || j.formattedDescription || null,
      postedAt: j.jobCreatedAt ? new Date(j.jobCreatedAt * 1000).toISOString() : null, workplaceType: wp(j.workplaceType),
      jobUrl: j.jobUrl,
    }));
  },
};

const WONSULTING_COOKIE = process.env.WONSULTING_COOKIE || '';
const WONSULTING_XSRF = (() => { const m = WONSULTING_COOKIE.match(/XSRF-TOKEN=([^;]+)/); try { return m ? decodeURIComponent(m[1]) : ''; } catch { return m ? m[1] : ''; } })();
const wonsulting = {
  name: 'wonsulting',
  enabled: () => !!(WONSULTING_COOKIE && WONSULTING_XSRF),
  async search(title, location, page) {
    const body = { job_title: title, location: location || '', work_setting: null, last_posted: null, longitude: null,
      latitude: null, page, jobs_per_page: PAGE_SIZE, sort_by: 'posted_at', sort_direction: 'desc', industry: null,
      radius: null, min_experience: null, max_experience: null, min_salary: null, max_salary: null, auto_apply_filter: true };
    const { status, json } = await httpPostJson('app.wonsulting.com', '/api/job-board/find-jobs', body, {
      accept: 'application/json, text/plain, */*', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      'x-xsrf-token': WONSULTING_XSRF, referer: 'https://app.wonsulting.com/job-board/search', origin: 'https://app.wonsulting.com', cookie: WONSULTING_COOKIE });
    if (status !== 200) { logger.warn({ status }, 'wonsulting non-200 (cookie expired?)'); return []; }
    return (json.jobs || []).filter((j) => j.apply_url && j.company).map((j) => {
      const atsName = j.ats_platform && typeof j.ats_platform === 'object' ? (j.ats_platform.display_name || j.ats_platform.name) : (typeof j.ats_platform === 'string' ? j.ats_platform : null);
      return { externalId: j.provider_job_id, source: 'wonsulting', atsHint: atsName, company: j.company, applyUrl: j.apply_url,
        title: j.title, location: j.location, description: j.description || null, postedAt: j.posted_at || null, workplaceType: wp(j.workplace_type), jobUrl: j.apply_url };
    });
  },
};

// jobhose (scale.jobs) — free public keyword+location API. `userId` is required but any string
// works (no account validation). Rich payload: ATS source, company, structured location, salary,
// experience, remote flag, full description. Direct job source (like liftmycv/wonsulting).
const JOBHOSE_USER = process.env.JOBHOSE_USER_ID || 'user_demandcrawl';
const JH_COUNTRIES = new Set(['united states', 'usa', 'us', 'united kingdom', 'uk', 'canada', 'germany', 'france', 'netherlands', 'australia', 'ireland', 'india', 'spain', 'singapore', 'united arab emirates', 'uae', 'saudi arabia', 'qatar', 'brazil', 'italy', 'italia', 'sweden', 'switzerland', 'japan', 'european union', 'europe', 'mexico', 'poland', 'portugal']);
const jobhose = {
  name: 'jobhose',
  enabled: () => true,
  async search(title, location, page) {
    const loc = (location || '').trim();
    const isCountry = JH_COUNTRIES.has(loc.toLowerCase());
    const locObj = loc ? [{ city: isCountry ? '' : loc, state: '', country: isCountry ? loc : '' }] : [{ city: '', state: '', country: 'United States' }];
    const take = Math.min(PAGE_SIZE, 50);
    const params = new URLSearchParams({ userId: JOBHOSE_USER, jobTitles: title, take: String(take), skip: String((page - 1) * take), source: 'live', searchMode: 'top-matched', locations: JSON.stringify(locObj) });
    const data = await httpGetJson(`https://jobhose-prod.scale.jobs/api/search-jobs?${params}`, { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', origin: 'https://scale.jobs', referer: 'https://scale.jobs/' });
    return (data?.jobs || []).filter((j) => j.url && j.organization && j.title).map((j) => {
      const jl = (j.jobLocations && j.jobLocations[0]) || null;
      const locStr = jl ? [jl.city, jl.country].filter(Boolean).join(', ') : ((j.locationsAltRaw && j.locationsAltRaw[0]) || j.locationType || null);
      return { externalId: j.externalId || j.id, source: 'jobhose', atsHint: j.source, company: j.organization,
        applyUrl: j.url, title: j.title, location: locStr, description: j.descriptionText || j.descriptionHtml || null,
        postedAt: j.datePosted || null, workplaceType: wp(j.aiWorkArrangement || (j.isRemote ? 'Remote' : j.locationType)), jobUrl: j.url };
    });
  },
};

// Google-dork discovery via Serper (PAID, capped). For each demanded (role, location) we run
// ONE combined dork — `"role" location (site:greenhouse OR site:lever OR ...)` — across the
// supported path-slug ATS, pull the company slugs out of the result URLs, and insert those
// companies as active+unsynced so the FREE ATS fleet harvests ALL their jobs (last_synced_at
// NULL => the fleet's NULLS-FIRST order crawls them next). Serper pays only for DISCOVERY; the
// jobs come free. Self-disables the instant the key errors/exhausts (non-200) so it never
// burns attempts, hard-capped per cycle. Enabled by default when SERPER_API_KEY is present.
const SERPER_KEY = process.env.SERPER_API_KEY || '';
const GOOGLE_DORK_ON = process.env.GOOGLE_DORK !== '0' && !!SERPER_KEY;
const DORK_MAX_REQ = parseInt(process.env.DORK_MAX_REQ || '40', 10); // per-CYCLE Serper query cap
const ATS_SITE = { greenhouse: ['boards.greenhouse.io', 'job-boards.greenhouse.io'], lever: ['jobs.lever.co'], ashby: ['jobs.ashbyhq.com'], smartrecruiters: ['jobs.smartrecruiters.com'] };
const DORK_ATS = (process.env.DORK_ATS || Object.keys(ATS_SITE).join(',')).split(',').map((s) => s.trim()).filter((a) => ATS_SITE[a]);
const DORK_SITES = DORK_ATS.flatMap((a) => ATS_SITE[a]);
let dorkReqUsed = 0, dorkDisabled = false, dorkNewCompanies = 0;

function serperSearch(q) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ q, num: 20, gl: 'us' });
    const req = https.request({ hostname: 'google.serper.dev', path: '/search', method: 'POST', timeout: 25000,
      headers: { 'X-API-KEY': SERPER_KEY, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let j = {}; try { j = JSON.parse(d); } catch {} resolve({ status: res.statusCode, json: j }); }); });
    req.on('error', reject); req.on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
    req.write(payload); req.end();
  });
}

const googledork = {
  name: 'googledork',
  enabled: () => GOOGLE_DORK_ON && !dorkDisabled && dorkReqUsed < DORK_MAX_REQ,
  async search(title, location) {
    if (dorkDisabled || dorkReqUsed >= DORK_MAX_REQ) return [];
    dorkReqUsed++;
    const sites = DORK_SITES.map((s) => `site:${s}`).join(' OR ');
    const dork = `"${title}"${location ? ` ${location}` : ''} (${sites})`;
    let res;
    try { res = await serperSearch(dork); }
    catch (e) { logger.warn({ err: e.message }, 'serper query failed'); return []; }
    if (res.status !== 200) { dorkDisabled = true; logger.warn({ status: res.status, msg: res.json?.message }, 'SERP unavailable/exhausted — googledork off for this run'); return []; }
    const found = new Map();
    for (const o of (res.json.organic || [])) {
      const c = deriveCompany(o.link, null, null, 'googledork');
      let slug; try { slug = decodeURIComponent(c.slug || ''); } catch { slug = c.slug || ''; }
      if (!DORK_ATS.includes(c.ats) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,60}$/.test(slug)) continue;
      if (!found.has(c.careerUrl)) found.set(c.careerUrl, { ats: c.ats, slug, careerUrl: c.careerUrl, domain: c.domain });
    }
    if (!DRY) {
      for (const c of found.values()) {
        try {
          const r = await query(
            `INSERT INTO companies (company_name, domain, ats, ats_slug, career_url, status, origin, last_synced_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'active', 'demand_googledork', NULL, NOW(), NOW())
             ON CONFLICT (career_url) DO NOTHING RETURNING id`,
            [c.slug, c.domain, c.ats, c.slug, c.careerUrl]);
          if (r.rows.length) dorkNewCompanies++;
        } catch (e) { logger.debug({ err: e.message }, 'dork company insert failed'); }
      }
      if (found.size) logger.info({ title: title.slice(0, 32), loc: location, hits: found.size, reqUsed: dorkReqUsed }, 'googledork: discovered ATS companies (fleet will harvest)');
    }
    return []; // no jobs returned directly — the free fleet harvests the discovered companies
  },
};

const SOURCES = [liftmycv, wonsulting, jobhose, googledork];

// ---------- storage ----------
async function upsertNormalized(n) {
  if (!n.externalId || !n.company || !n.applyUrl) return 0;
  const c = deriveCompany(n.applyUrl, n.atsHint, n.company, n.source);
  if (!c.slug || !c.careerUrl) return 0;
  if (DRY) return 0;
  const cRes = await query(
    `INSERT INTO companies (company_name, domain, ats, ats_slug, career_url, status, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, NOW(), NOW())
     ON CONFLICT (career_url) DO UPDATE SET company_name = COALESCE(companies.company_name, EXCLUDED.company_name), updated_at = NOW()
     RETURNING id`,
    [n.company, c.domain, c.ats, c.slug, c.careerUrl, `demand_${n.source}`]);
  const companyId = cRes.rows[0]?.id;
  if (!companyId) return 0;
  const tags = classifyJob({ title: n.title, location: n.location, description: n.description || '', workplace_type: n.workplaceType }) || {};
  const raw = JSON.stringify({ source: `demand_${n.source}`, applyUrl: n.jobUrl });
  const jRes = await query(
    `INSERT INTO jobs (external_id, company_id, ats, title, location, workplace_type, description, url,
        posted_at, is_remote, remote_worldwide, experience_level, raw_data, first_seen_at, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())
     ON CONFLICT (external_id, company_id) DO UPDATE SET
       location = EXCLUDED.location, description = COALESCE(EXCLUDED.description, jobs.description),
       url = EXCLUDED.url, last_seen_at = NOW(), removed_at = NULL
     RETURNING (xmax = 0) AS inserted`,
    [String(n.externalId), companyId, c.ats, n.title, n.location, n.workplaceType, n.description, n.jobUrl,
      n.postedAt, n.workplaceType === 'remote' || !!tags.is_remote, !!tags.remote_worldwide, tags.experience_level || null, raw]);
  return jRes.rows[0]?.inserted ? 1 : 0;
}

function splitList(s, cap) { return String(s || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, cap); }

async function crawlDemand(row) {
  const titles = splitList(row.query_text, MAX_TITLES);
  const locList = splitList(row.location, MAX_LOCATIONS);
  const locs = locList.length ? locList : [null];
  const perSource = {};
  let added = 0, fetched = 0;
  for (const title of titles) {
    for (const loc of locs) {
      for (const src of SOURCES.filter((s) => s.enabled())) {
        for (let p = 1; p <= PAGES; p++) {
          let jobs;
          try { jobs = await src.search(title, loc, p); }
          catch (e) { logger.warn({ src: src.name, title, loc, err: e.message }, 'source fetch failed'); break; }
          if (!jobs.length) break;
          fetched += jobs.length;
          for (const j of jobs) { try { const n = await upsertNormalized(j); added += n; perSource[src.name] = (perSource[src.name] || 0) + n; } catch (e) { logger.debug({ err: e.message }, 'upsert failed'); } }
          await sleep(DELAY_MS);
          if (jobs.length < PAGE_SIZE) break;
        }
      }
    }
  }
  // Re-count actual coverage now, so a demand that's now satisfied drops OUT of the unmet queue
  // (otherwise last_result_count keeps its old low value until a user happens to re-search it,
  // and the crawler keeps re-picking it). Best-effort; plainto_tsquery is injection/parse-safe.
  let resultCount = null;
  if (!DRY) {
    try {
      const firstTitle = splitList(row.query_text, 1)[0];
      const firstLoc = splitList(row.location, 1)[0];
      if (firstTitle) {
        const params = [firstTitle];
        let locClause = '';
        if (firstLoc) { locClause = ' AND location ILIKE ?'; params.push(`%${firstLoc}%`); }
        const rc = await query(`SELECT count(*) n FROM jobs WHERE removed_at IS NULL AND search_vector @@ plainto_tsquery('english', ?)${locClause}`, params);
        resultCount = parseInt(rc.rows[0].n, 10);
      }
    } catch (e) { logger.debug({ err: e.message }, 'demand re-count failed'); }
    if (resultCount != null) {
      await query('UPDATE search_demand SET last_crawled_at = NOW(), jobs_added = COALESCE(jobs_added,0) + ?, last_result_count = ? WHERE demand_key = ?', [added, resultCount, row.demand_key]);
    } else {
      await query('UPDATE search_demand SET last_crawled_at = NOW(), jobs_added = COALESCE(jobs_added,0) + ? WHERE demand_key = ?', [added, row.demand_key]);
    }
  }
  return { added, fetched, perSource, resultCount };
}

async function ensureColumns() {
  for (const ddl of ['ALTER TABLE search_demand ADD COLUMN IF NOT EXISTS last_crawled_at TIMESTAMP',
    'ALTER TABLE search_demand ADD COLUMN IF NOT EXISTS jobs_added INTEGER DEFAULT 0']) {
    try { await query(ddl); } catch (e) { logger.warn({ err: e.message }, 'ensureColumns'); }
  }
}

async function cycle() {
  dorkReqUsed = 0; dorkNewCompanies = 0; // per-cycle reset (Serper cap + discovery counter)
  const active = SOURCES.filter((s) => s.enabled()).map((s) => s.name);
  logger.info({ sources: active, dry: DRY }, 'demand-crawl: active sources');
  const { rows } = await query(
    `SELECT demand_key, query_text, location, search_count, last_result_count
       FROM search_demand
      WHERE COALESCE(last_result_count, 0) <= ? AND query_text IS NOT NULL AND query_text <> ''
        AND (last_crawled_at IS NULL OR last_crawled_at < NOW() - INTERVAL '${RECRAWL_HOURS} hours')
      ORDER BY search_count DESC, last_result_count ASC LIMIT ?`,
    [THRESHOLD, BATCH]);
  if (!rows.length) { logger.info('demand-crawl: no unmet demand due'); return { demands: 0, added: 0 }; }
  let totalAdded = 0, totalFetched = 0;
  for (const row of rows) {
    const { added, fetched, perSource, resultCount } = await crawlDemand(row);
    totalAdded += added; totalFetched += fetched;
    logger.info({ q: (row.query_text || '').slice(0, 48), loc: row.location, searches: row.search_count, was_results: row.last_result_count, now_results: resultCount, fetched, added, perSource, dry: DRY }, 'demand crawled');
  }
  logger.info({ demands: rows.length, fetched: totalFetched, added: totalAdded, dorkReqUsed, dorkNewCompanies, dorkDisabled, dry: DRY }, 'demand-crawl cycle complete');
  return { demands: rows.length, added: totalAdded };
}

// Only run the crawl loop when executed directly (`node demand-crawl.js`), not when required
// for testing — otherwise `require()` would kick off a full cycle + closeDb.
if (require.main === module) {
  (async () => {
    if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }
    await ensureColumns();
    do {
      try { await cycle(); } catch (e) { logger.error({ err: e.message, stack: e.stack }, 'demand-crawl cycle error'); }
      if (LOOP) await sleep(RECHECK_S * 1000);
    } while (LOOP);
    await closeDb();
    process.exit(0);
  })().catch((e) => { logger.error({ err: e.message }, 'demand-crawl fatal'); process.exit(1); });
}

module.exports = { cycle, crawlDemand, upsertNormalized, deriveCompany, ensureColumns };
