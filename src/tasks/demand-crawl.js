#!/usr/bin/env node
/**
 * Phase 2 — demand-driven crawling.
 *
 * Reads the top UNMET demand from search_demand (searched a lot, returned few results — the
 * unsatisfied customers Phase 0 surfaced), then goes and fetches exactly those jobs from the
 * keyword+location-searchable LiftMyCV catalog and upserts them straight into Postgres. So the
 * next user who searches "diesel mechanic in Nevada" actually finds jobs.
 *
 * Demand rows carry OR-lists ("inventory analyst,procurement analyst" across "canada,toronto")
 * — we split them into individual (title × location) queries (capped) and fetch each.
 *
 * Jobs are stored EXACTLY like scripts/fetch-liftmycv.js already stores its ~319k jobs
 * (company keyed by career_url, external_id = LiftMyCV job id) so they merge, not duplicate.
 *
 * Run:  DATABASE_URL=... node src/tasks/demand-crawl.js          # one drain of due demand
 *       DATABASE_URL=... LOOP=1 node src/tasks/demand-crawl.js   # keep re-checking
 *       DATABASE_URL=... DRY=1 node src/tasks/demand-crawl.js    # fetch+map, write nothing
 * Env:  DEMAND_MAX_RESULTS(10) DEMAND_BATCH(15) DEMAND_RECRAWL_HOURS(6)
 *       DEMAND_MAX_TITLES(3) DEMAND_MAX_LOCATIONS(2) DEMAND_PAGES(1) DEMAND_PAGE_SIZE(100)
 *       DEMAND_DELAY_MS(1200) RECHECK_S(600)
 */
const https = require('https');
const { query, closeDb } = require('../db/connection');
const logger = require('../logger');
const { classifyJob } = require('../utils/classify');

const THRESHOLD = parseInt(process.env.DEMAND_MAX_RESULTS || '10', 10); // "unmet" = returned <= this
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

// --- LiftMyCV API + mapping (ported from scripts/fetch-liftmycv.js) ---
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 20000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`JSON parse: ${e.message}`)); } });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}
function mapPlatformToAts(p) {
  const map = { greenhouse: 'greenhouse', lever: 'lever', ashby: 'ashby', workable: 'workable', bamboohr: 'bamboohr', smartrecruiters: 'smartrecruiters', recruitee: 'recruitee', breezy: 'breezy', personio: 'personio', pinpoint: 'pinpoint', jazzhr: 'jazzhr', rippling: 'rippling', zoho: 'zoho' };
  return map[p?.toLowerCase()] || p?.toLowerCase() || 'unknown';
}
function extractSlugFromUrl(companyUrl) {
  if (!companyUrl) return null;
  try {
    const u = new URL(companyUrl);
    const host = u.hostname.toLowerCase();
    if (host.endsWith('.myworkdayjobs.com')) return host.split('.')[0] || null;
    if (host.endsWith('.icims.com')) return host.split('.')[0] || null;
    return u.pathname.split('/').filter(Boolean)[0] || null;
  } catch { return null; }
}
function workplaceType(job) {
  const wt = job.workplaceType?.toUpperCase();
  if (wt === 'REMOTE') return 'remote';
  if (wt === 'HYBRID') return 'hybrid';
  if (wt === 'ONSITE' || wt === 'ON_SITE') return 'onsite';
  return null;
}

async function liftSearch(role, location, page) {
  const params = new URLSearchParams({ roles: role, count: String(PAGE_SIZE), page: String(page) });
  if (location) params.set('location', location);
  const data = await httpGet(`https://app.liftmycv.com/api/v1/jobs/search?${params}`);
  return data?.results?.jobs || [];
}

// Upsert one LiftMyCV job into Postgres (company by career_url, job by external_id+company_id).
// Returns 1 if the job row was newly inserted, else 0.
async function upsertJob(job) {
  const slug = extractSlugFromUrl(job.companyUrl);
  if (!slug || !job.company || !job.id) return 0;
  const ats = mapPlatformToAts(job.platform);
  const careerUrl = (job.companyUrl || '').replace(/\/$/, '') || `https://unknown/${slug}`;
  let domain; try { domain = new URL(careerUrl).hostname; } catch { domain = slug; }
  if (DRY) return 0;

  const cRes = await query(
    `INSERT INTO companies (company_name, domain, ats, ats_slug, career_url, status, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', 'demand_liftmycv', NOW(), NOW())
     ON CONFLICT (career_url) DO UPDATE SET
       company_name = COALESCE(companies.company_name, EXCLUDED.company_name), updated_at = NOW()
     RETURNING id`,
    [job.company, domain, ats, slug, careerUrl]);
  const companyId = cRes.rows[0]?.id;
  if (!companyId) return 0;

  const wt = workplaceType(job);
  const description = job.description || job.formattedDescription || null;
  const tags = classifyJob({ title: job.role, location: job.location, description: description || '', workplace_type: wt }) || {};
  const postedAt = job.jobCreatedAt ? new Date(job.jobCreatedAt * 1000).toISOString() : null;
  const raw = JSON.stringify({ platform: job.platform, salary: job.salary, logoUrl: job.logoUrl, summary: job.summary, source: 'demand_liftmycv' });

  const jRes = await query(
    `INSERT INTO jobs (external_id, company_id, ats, title, location, workplace_type, description, url,
        posted_at, is_remote, remote_worldwide, experience_level, raw_data, first_seen_at, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())
     ON CONFLICT (external_id, company_id) DO UPDATE SET
       location = EXCLUDED.location,
       description = COALESCE(EXCLUDED.description, jobs.description),
       url = EXCLUDED.url, last_seen_at = NOW(), removed_at = NULL
     RETURNING (xmax = 0) AS inserted`,
    [job.id, companyId, ats, job.role, job.location, wt, description, job.jobUrl, postedAt,
      wt === 'remote' || !!tags.is_remote, !!tags.remote_worldwide, tags.experience_level || null, raw]);
  return jRes.rows[0]?.inserted ? 1 : 0;
}

function splitList(s, cap) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, cap);
}

async function crawlDemand(row) {
  const titles = splitList(row.query_text, MAX_TITLES);
  const locs = splitList(row.location, MAX_LOCATIONS);
  const locList = locs.length ? locs : [null];
  let added = 0, fetched = 0;
  for (const title of (titles.length ? titles : [])) {
    for (const loc of locList) {
      for (let p = 1; p <= PAGES; p++) {
        let jobs;
        try { jobs = await liftSearch(title, loc, p); }
        catch (e) { logger.warn({ title, loc, err: e.message }, 'liftmycv fetch failed'); break; }
        if (!jobs.length) break;
        fetched += jobs.length;
        for (const j of jobs) { try { added += await upsertJob(j); } catch (e) { logger.debug({ err: e.message }, 'job upsert failed'); } }
        await sleep(DELAY_MS);
        if (jobs.length < PAGE_SIZE) break;
      }
    }
  }
  if (!DRY) await query('UPDATE search_demand SET last_crawled_at = NOW(), jobs_added = COALESCE(jobs_added,0) + ? WHERE demand_key = ?', [added, row.demand_key]);
  return { added, fetched };
}

async function ensureColumns() {
  for (const ddl of [
    'ALTER TABLE search_demand ADD COLUMN IF NOT EXISTS last_crawled_at TIMESTAMP',
    'ALTER TABLE search_demand ADD COLUMN IF NOT EXISTS jobs_added INTEGER DEFAULT 0',
  ]) { try { await query(ddl); } catch (e) { logger.warn({ err: e.message }, 'ensureColumns'); } }
}

async function cycle() {
  const { rows } = await query(
    `SELECT demand_key, query_text, location, search_count, last_result_count
       FROM search_demand
      WHERE COALESCE(last_result_count, 0) <= ?
        AND query_text IS NOT NULL AND query_text <> ''
        AND (last_crawled_at IS NULL OR last_crawled_at < NOW() - INTERVAL '${RECRAWL_HOURS} hours')
      ORDER BY search_count DESC, last_result_count ASC
      LIMIT ?`,
    [THRESHOLD, BATCH]);
  if (!rows.length) { logger.info('demand-crawl: no unmet demand due'); return { demands: 0, added: 0 }; }
  let totalAdded = 0, totalFetched = 0;
  for (const row of rows) {
    const { added, fetched } = await crawlDemand(row);
    totalAdded += added; totalFetched += fetched;
    logger.info({ q: (row.query_text || '').slice(0, 48), loc: row.location, searches: row.search_count, was_results: row.last_result_count, fetched, added, dry: DRY }, 'demand crawled');
  }
  logger.info({ demands: rows.length, fetched: totalFetched, added: totalAdded, dry: DRY }, 'demand-crawl cycle complete');
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

module.exports = { cycle, crawlDemand, upsertJob };
