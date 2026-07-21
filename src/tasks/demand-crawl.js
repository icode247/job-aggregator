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
const BATCH = parseInt(process.env.DEMAND_BATCH || '15', 10);
const RECRAWL_HOURS = parseInt(process.env.DEMAND_RECRAWL_HOURS || '6', 10);
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

const SCRAPINGDOG_KEY = process.env.SCRAPINGDOG_KEY || '';
const GOOGLE_JOBS_ON = process.env.GOOGLE_JOBS === '1' && !!SCRAPINGDOG_KEY;
let googleReqUsed = 0;
const GOOGLE_JOBS_MAX_REQ = parseInt(process.env.GOOGLE_JOBS_MAX_REQ || '40', 10); // hard per-run cap (PAID)
const googlejobs = {
  name: 'googlejobs',
  enabled: () => GOOGLE_JOBS_ON && googleReqUsed < GOOGLE_JOBS_MAX_REQ,
  async search(title, location) {
    if (googleReqUsed >= GOOGLE_JOBS_MAX_REQ) return [];
    googleReqUsed++;
    const q = encodeURIComponent(location ? `${title} ${location}` : title);
    const data = await httpGetJson(`https://api.scrapingdog.com/google_jobs?api_key=${SCRAPINGDOG_KEY}&query=${q}&country=us`);
    return (data?.jobs_results || data?.jobs || []).map((j) => {
      const apply = (j.apply_options && j.apply_options[0] && j.apply_options[0].link) || j.share_link || j.link || null;
      return { externalId: j.job_id || `gj_${Buffer.from(`${j.title}|${j.company_name}|${j.location}`).toString('base64').slice(0, 40)}`,
        source: 'googlejobs', atsHint: 'googlejobs', company: j.company_name, applyUrl: apply || `googlejobs://${(j.company_name || 'unknown')}`,
        title: j.title, location: j.location, description: j.description || null, postedAt: null, workplaceType: wp(j.detected_extensions?.work_from_home ? 'REMOTE' : null), jobUrl: apply };
    }).filter((j) => j.company && j.title);
  },
};

const SOURCES = [liftmycv, wonsulting, googlejobs];

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
  if (!DRY) await query('UPDATE search_demand SET last_crawled_at = NOW(), jobs_added = COALESCE(jobs_added,0) + ? WHERE demand_key = ?', [added, row.demand_key]);
  return { added, fetched, perSource };
}

async function ensureColumns() {
  for (const ddl of ['ALTER TABLE search_demand ADD COLUMN IF NOT EXISTS last_crawled_at TIMESTAMP',
    'ALTER TABLE search_demand ADD COLUMN IF NOT EXISTS jobs_added INTEGER DEFAULT 0']) {
    try { await query(ddl); } catch (e) { logger.warn({ err: e.message }, 'ensureColumns'); }
  }
}

async function cycle() {
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
    const { added, fetched, perSource } = await crawlDemand(row);
    totalAdded += added; totalFetched += fetched;
    logger.info({ q: (row.query_text || '').slice(0, 48), loc: row.location, searches: row.search_count, was_results: row.last_result_count, fetched, added, perSource, dry: DRY }, 'demand crawled');
  }
  logger.info({ demands: rows.length, fetched: totalFetched, added: totalAdded, googleReqUsed, dry: DRY }, 'demand-crawl cycle complete');
  return { demands: rows.length, added: totalAdded };
}

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

module.exports = { cycle, crawlDemand, upsertNormalized, deriveCompany };
