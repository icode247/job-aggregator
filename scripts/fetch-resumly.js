#!/usr/bin/env node
/**
 * One-shot drain of a resumly.ai supplemental-jobs query into Postgres.
 *
 * resumly's API (8tilziinw8.execute-api…/Prod/job-search/public-jobs-supplemental) returns
 * ATS-aggregated jobs for a saved query_id. Auth is a 24h Cognito JWT, so this is a MANUAL
 * one-time run (not an always-on source) — paginate the query to exhaustion, upsert each job.
 *
 * Jobs are stored via the shared demand-crawl mapping (company keyed by career_url, origin
 * demand_resumly) so they merge with existing rows.
 *
 * Run:
 *   RESUMLY_TOKEN=<bearer> RESUMLY_QUERY_ID=<id> DATABASE_URL=... node scripts/fetch-resumly.js
 * Env: RESUMLY_PAGE_SIZE(25) RESUMLY_MAX_PAGES(0=until has_more=false) RESUMLY_DELAY_MS(400)
 */
const https = require('https');
const { upsertNormalized } = require('../src/tasks/demand-crawl');
const { closeDb } = require('../src/db/connection');
const logger = require('../src/logger');

const TOKEN = process.env.RESUMLY_TOKEN || '';
const QUERY_ID = process.env.RESUMLY_QUERY_ID || '';
const PAGE_SIZE = parseInt(process.env.RESUMLY_PAGE_SIZE || '25', 10);
const MAX_PAGES = parseInt(process.env.RESUMLY_MAX_PAGES || '0', 10); // 0 = drain fully
const DELAY_MS = parseInt(process.env.RESUMLY_DELAY_MS || '400', 10);
const HOST = '8tilziinw8.execute-api.us-east-1.amazonaws.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getPage(page) {
  const path = `/Prod/job-search/public-jobs-supplemental?query_id=${encodeURIComponent(QUERY_ID)}&page=${page}&page_size=${PAGE_SIZE}`;
  return new Promise((resolve, reject) => {
    https.get({ hostname: HOST, path, timeout: 25000, headers: { authorization: `Bearer ${TOKEN}`, origin: 'https://app.resumly.ai', 'cache-control': 'no-cache' } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 160)}`)); try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('JSON parse: ' + e.message)); } });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

// resumly job -> demand-crawl normalized shape
function normalize(j) {
  const wa = String(j.ai_work_arrangement || '').toLowerCase();
  const workplaceType = j.remote_derived || wa.includes('remote') ? 'remote' : wa.includes('hybrid') ? 'hybrid' : wa.includes('site') ? 'onsite' : null;
  return {
    externalId: j.id || j._id,
    source: 'resumly',
    atsHint: j.source, // icims / greenhouse / workday / lever.co / paylocity / phenompeople / eightfold / trinet / paycor…
    company: j.organization,
    applyUrl: j.url,
    title: j.title,
    location: Array.isArray(j.locations_derived) ? j.locations_derived[0] : null,
    description: null, // this endpoint carries no description; ATS backfill fills it later
    postedAt: j.date_posted || null,
    workplaceType,
    jobUrl: j.url,
  };
}

(async () => {
  if (!TOKEN || !QUERY_ID || !process.env.DATABASE_URL) {
    console.error('Set RESUMLY_TOKEN, RESUMLY_QUERY_ID, and DATABASE_URL');
    process.exit(1);
  }
  let page = 1, seen = 0, added = 0, skipped = 0;
  const bySource = {};
  const t0 = Date.now();
  while (true) {
    let data;
    try { data = await getPage(page); }
    catch (e) { logger.error({ page, err: e.message }, 'resumly fetch failed — stopping'); break; }
    const rows = data.result || [];
    if (!rows.length) break;
    for (const j of rows) {
      seen++;
      const n = normalize(j);
      try {
        const ins = await upsertNormalized(n);
        added += ins;
        bySource[j.source] = (bySource[j.source] || 0) + ins;
      } catch (e) { skipped++; logger.debug({ err: e.message }, 'upsert failed'); }
    }
    logger.info({ page, pageRows: rows.length, seen, added, hasMore: data.has_more }, 'resumly page drained');
    if (!data.has_more) break;
    if (MAX_PAGES && page >= MAX_PAGES) break;
    page++;
    await sleep(DELAY_MS);
  }
  logger.info({ pages: page, seen, added, skipped, bySource, minutes: ((Date.now() - t0) / 60000).toFixed(1) }, 'resumly drain complete');
  await closeDb();
  process.exit(0);
})().catch((e) => { logger.error({ err: e.message }, 'resumly drain fatal'); process.exit(1); });
