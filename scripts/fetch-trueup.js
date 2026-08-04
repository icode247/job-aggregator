#!/usr/bin/env node
/**
 * TrueUp (trueup.io) job crawler.
 *
 * TrueUp proxies its Algolia "job" index (~262k postings) through an AUTHENTICATED
 * endpoint:
 *   POST https://arc.trueup.io/jobs/search/member
 *   headers: authorization: Bearer <clerk JWT>, origin: https://www.trueup.io
 *   body:    {"requests":[{"indexName":"job","params":"<algolia params>"}]}
 *   resp:    {"results":[{ hits, nbHits, nbPages, ... }]}   (Algolia format)
 *
 * The Clerk JWT expires ~60s after issue, so we can't crawl slowly. Strategy:
 *   PHASE 1 (token-bound, fast): walk the index in descending updated_at_timestamp
 *           windows, collecting matching hits in MEMORY only. No DB writes.
 *   PHASE 2 (no token): bulk-upsert the collected jobs to Postgres.
 * If the token 401s mid-scan we stop, write what we have, and print the last
 * timestamp reached so a re-run can resume (START_TS) with a fresh token.
 *
 * For now we ONLY keep gh/wd/ic/sm/re (platforms we already crawl); the rest are
 * skipped per request.
 *
 * Run (grab a FRESH token from DevTools right before — they last 60s):
 *   TRUEUP_TOKEN='eyJ...' DB_URL=$(heroku config:get DATABASE_URL -a fastapply-board) \
 *     node scripts/fetch-trueup.js
 * Env: ALGOLIA_INDEX (default 'job'), ORIGIN (default 'trueup'), START_TS, MAX_WINDOWS.
 */
const { Client } = require('pg');

const TOKEN = process.env.TRUEUP_TOKEN;
const ENDPOINT = process.env.TRUEUP_ENDPOINT || 'https://arc.trueup.io/jobs/search/member';
const INDEX = process.env.ALGOLIA_INDEX || 'job';
const ORIGIN = process.env.ORIGIN || 'trueup';
const MAX_WINDOWS = parseInt(process.env.MAX_WINDOWS || '5000');

const PREFIX_ATS = { gh: 'greenhouse', wd: 'workday', ic: 'icims', sm: 'smartrecruiters', re: 'recruitee' };

function parseAtsSlug(ats, url, refCompany) {
  try {
    const u = new URL(url);
    if (ats === 'greenhouse') return (u.pathname.match(/^\/([^/]+)\/jobs/) || [])[1] || refCompany;
    if (ats === 'smartrecruiters') return (u.pathname.match(/^\/([^/]+)/) || [])[1] || refCompany;
    if (ats === 'icims') return (u.hostname.match(/^(?:careers-)?([^.]+)\.icims\.com/) || [])[1] || refCompany;
    if (ats === 'workday') return (u.hostname.match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com/) || [])[1] || refCompany;
    if (ats === 'recruitee') return (u.hostname.match(/^([^.]+)\.recruitee\.com/) || [])[1] || refCompany;
  } catch { /* */ }
  return refCompany;
}

async function search(params) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', origin: 'https://www.trueup.io' },
    body: JSON.stringify([{ indexName: INDEX, params }]),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 401 || res.status === 403) { const e = new Error('TOKEN_EXPIRED'); e.expired = true; throw e; }
  if (!res.ok) throw new Error(`search HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).results[0];
}

// TrueUp's job-search API now expects `params` as an OBJECT with
// `trueupRequestVersion: 2` (was a URL-encoded string — that's what triggered
// "Unsupported job-search request version").
const buildParams = (maxTs, page = 0) => {
  const p = { hitsPerPage: 1000, page, query: '', trueupRequestVersion: 2 };
  if (maxTs != null) p.numericFilters = ['updated_at_timestamp<' + maxTs];
  return p;
};

async function main() {
  if (!TOKEN) { console.error('Set TRUEUP_TOKEN (fresh Bearer from DevTools; expires in 60s)'); process.exit(1); }
  if (!process.env.DB_URL) { console.error('Set DB_URL'); process.exit(1); }

  // ---- PHASE 1: scan into memory (token-bound) ----
  const collected = new Map(); // ats_job_ref -> hit fields we need
  let maxTs = process.env.START_TS ? parseInt(process.env.START_TS) : null;
  let scanned = 0, windows = 0, expired = false, lastTs = maxTs;
  const t0 = Date.now();

  scan: for (let w = 0; w < MAX_WINDOWS; w++) {
    let r;
    try { r = await search(buildParams(maxTs, 0)); }
    catch (e) { if (e.expired) { expired = true; break; } console.error('scan error:', e.message); break; }
    windows++;
    if (!r.hits.length) break;
    let windowMin = maxTs;
    for (const h of r.hits) {
      scanned++;
      if (h.updated_at_timestamp != null) windowMin = windowMin == null ? h.updated_at_timestamp : Math.min(windowMin, h.updated_at_timestamp);
      const ref = h.ats_job_ref; if (!ref || collected.has(ref)) continue;
      const ats = PREFIX_ATS[(ref.split('-')[0] || '').toLowerCase()];
      if (!ats || !h.url) continue;
      collected.set(ref, { ref, ats, url: h.url, title: h.title, location: h.location,
        smin: h.salary_range_min, smax: h.salary_range_max, ts: h.updated_at_timestamp,
        company: h.company_name, domain: h.normalized_domain, refCompany: ref.split('-').slice(1, -1).join('-') });
    }
    if (windowMin == null || windowMin === maxTs) break;  // no progress
    lastTs = maxTs = windowMin;
    if (windows % 20 === 0) console.log(`  scan: ${windows} windows | ${scanned} scanned | ${collected.size} kept | ${((Date.now()-t0)/1000).toFixed(0)}s`);
  }
  console.log(`PHASE 1 done: ${windows} windows | scanned ${scanned} | kept ${collected.size} | ${expired ? 'TOKEN EXPIRED' : 'complete'} | ${((Date.now()-t0)/1000).toFixed(0)}s`);

  // ---- PHASE 2: upsert to Postgres (no token needed) ----
  const c = new Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const companyId = new Map();
  async function upsertCompany(ats, slug) {
    const boards = { greenhouse: `https://boards.greenhouse.io/${slug}`, workday: `https://${slug}.myworkdayjobs.com`,
      icims: `https://careers-${slug}.icims.com`, smartrecruiters: `https://jobs.smartrecruiters.com/${slug}`, recruitee: `https://${slug}.recruitee.com` };
    const careerUrl = boards[ats];
    if (companyId.has(careerUrl)) return companyId.get(careerUrl);
    const r = await c.query(
      `INSERT INTO companies (company_name, ats, ats_slug, career_url, status, origin, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'active',$5,NOW(),NOW()) ON CONFLICT (career_url) DO UPDATE SET updated_at=NOW() RETURNING id`,
      [slug, ats, slug, careerUrl, ORIGIN]);
    companyId.set(careerUrl, r.rows[0].id); return r.rows[0].id;
  }
  let inserted = 0; const byAts = {};
  for (const j of collected.values()) {
    const slug = parseAtsSlug(j.ats, j.url, j.refCompany); if (!slug) continue;
    try {
      const cid = await upsertCompany(j.ats, slug);
      const res = await c.query(
        `INSERT INTO jobs (external_id, company_id, ats, title, location, salary_min, salary_max, url, posted_at, raw_data, first_seen_at, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,${j.ts ? 'to_timestamp($9)' : 'NULL'},$10,NOW(),NOW())
         ON CONFLICT (external_id, company_id) DO UPDATE SET title=EXCLUDED.title, location=EXCLUDED.location,
           url=EXCLUDED.url, salary_min=EXCLUDED.salary_min, salary_max=EXCLUDED.salary_max, last_seen_at=NOW(), removed_at=NULL
         RETURNING (xmax=0) AS isnew`,
        j.ts
          ? [j.ref, cid, j.ats, j.title, j.location, j.smin, j.smax, j.url, j.ts, JSON.stringify({ source: 'trueup', company: j.company, domain: j.domain })]
          : [j.ref, cid, j.ats, j.title, j.location, j.smin, j.smax, j.url, JSON.stringify({ source: 'trueup', company: j.company, domain: j.domain })]);
      if (res.rows[0]?.isnew) { inserted++; byAts[j.ats] = (byAts[j.ats] || 0) + 1; }
    } catch { /* skip */ }
  }
  console.log(`PHASE 2 done: inserted ${inserted} new jobs | by ATS: ${JSON.stringify(byAts)}`);
  if (expired) console.log(`Token expired mid-scan. Re-run with a fresh token and START_TS=${lastTs} to continue.`);
  await c.end();
  process.exit(0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
