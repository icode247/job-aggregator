#!/usr/bin/env node
/**
 * Bulk one-shot drain of resumly.ai across the top demand roles.
 *
 * resumly meters its DB one saved-query at a time (plan cap = 1 query slot, ~1000 jobs/role).
 * So we cycle the SINGLE query slot through the top roles in search_demand: update the query
 * (title_filter + location_filter/remote_filter) -> paginate to exhaustion -> upsert -> next.
 * The saved search is RESTORED at the end. 24h Cognito JWT auth, so this is a manual one-time run.
 *
 * Run:
 *   RESUMLY_TOKEN=<bearer> RESUMLY_QUERY_ID=<id> DATABASE_URL=... node scripts/fetch-resumly-bulk.js
 * Env: DEMAND_LIMIT(50) RESUMLY_MAX_PAGES(40) RESUMLY_PAGE_SIZE(25) RESUMLY_DELAY_MS(350)
 *      RESTORE_TITLE("financial analyst") RESTORE_LOCATION("United States")
 */
const https = require('https');
const fs = require('fs');
const { upsertNormalized } = require('../src/tasks/demand-crawl');
const { query, closeDb } = require('../src/db/connection');
const logger = require('../src/logger');

// ROLE_SOURCE=roles drains the comprehensive resumly-roles.js vocabulary (US by default);
// otherwise the top DEMAND_LIMIT search_demand rows. CHECKPOINT persists completed roles so a
// re-run (after a crash / token refresh) skips what's done — essential for the long full-vocab run.
const ROLE_SOURCE = process.env.ROLE_SOURCE || 'demand';
const ROLE_LOCATION = process.env.RESUMLY_LOCATION || 'United States';
const CHECKPOINT = process.env.RESUMLY_CHECKPOINT || '/tmp/resumly-done.txt';
// FETCH_FILE: when set, write normalized jobs to this JSONL (deduped by externalId) instead of
// upserting to Postgres. This makes the token-bound phase ~30x faster (no per-job DB round-trip);
// scripts/import-resumly-file.js batch-loads the file into Postgres afterward (no token needed).
const FETCH_FILE = process.env.FETCH_FILE || '';

const TOKEN = process.env.RESUMLY_TOKEN || '';
const QID = process.env.RESUMLY_QUERY_ID || '';
const DEMAND_LIMIT = parseInt(process.env.DEMAND_LIMIT || '50', 10);
const MAX_PAGES = parseInt(process.env.RESUMLY_MAX_PAGES || '40', 10); // resumly caps ~1000/role = 40 pages
const PAGE_SIZE = parseInt(process.env.RESUMLY_PAGE_SIZE || '25', 10);
const DELAY_MS = parseInt(process.env.RESUMLY_DELAY_MS || '350', 10);
const HOST = '8tilziinw8.execute-api.us-east-1.amazonaws.com';
const BASE = '/Prod/job-search';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { authorization: `Bearer ${TOKEN}`, origin: 'https://app.resumly.ai', 'content-type': 'application/json' };

function reqOnce(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = { hostname: HOST, path, method, timeout: 25000, headers: { ...H } };
    if (payload) opts.headers['content-length'] = Buffer.byteLength(payload);
    const r = https.request(opts, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    r.on('error', reject); r.on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
    if (payload) r.write(payload); r.end();
  });
}
// Retry transient network errors (timeout / reset / home-network blip) so a single hiccup
// during the multi-hour run doesn't abort a role — 3 tries with backoff.
async function req(method, path, body) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try { return await reqOnce(method, path, body); }
    catch (e) { lastErr = e; await sleep(1500 * (i + 1)); }
  }
  throw lastErr;
}
const splitList = (s, cap) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, cap);
const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

// Point the single query slot at this demand (title list + location list, or remote if no location).
async function setQuery(titles, locs) {
  const body = { query_id: QID, query_name: 'demandcrawl', title_filter: titles };
  if (locs.length) body.location_filter = locs.map(titleCase);
  else body.remote_filter = true;
  let res = await req('PUT', `${BASE}/query/${QID}`, body);
  if (res.status !== 200 && locs.length) { // bad location -> fall back to US
    res = await req('PUT', `${BASE}/query/${QID}`, { query_id: QID, query_name: 'demandcrawl', title_filter: titles, location_filter: ['United States'] });
  }
  return res.status === 200;
}

function normalize(j) {
  const wa = String(j.ai_work_arrangement || '').toLowerCase();
  const workplaceType = j.remote_derived || wa.includes('remote') ? 'remote' : wa.includes('hybrid') ? 'hybrid' : wa.includes('site') ? 'onsite' : null;
  return { externalId: j.id || j._id, source: 'resumly', atsHint: j.source, company: j.organization, applyUrl: j.url,
    title: j.title, location: Array.isArray(j.locations_derived) ? j.locations_derived[0] : null,
    description: null, postedAt: j.date_posted || null, workplaceType, jobUrl: j.url };
}

const fileSeen = new Set(); // dedup ids across roles when writing to file
async function drainCurrentQuery() {
  let page = 1, added = 0, seen = 0;
  while (page <= MAX_PAGES) {
    const res = await req('GET', `${BASE}/public-jobs-supplemental?query_id=${QID}&page=${page}&page_size=${PAGE_SIZE}`);
    if (res.status !== 200) { logger.warn({ status: res.status }, 'resumly page non-200 — stop role'); break; }
    let data; try { data = JSON.parse(res.body); } catch { break; }
    const rows = data.result || [];
    if (!rows.length) break;
    for (const j of rows) {
      seen++;
      const n = normalize(j);
      if (FETCH_FILE) {
        const id = String(n.externalId || '');
        if (id && !fileSeen.has(id)) { fileSeen.add(id); fs.appendFileSync(FETCH_FILE, JSON.stringify(n) + '\n'); added++; }
      } else {
        try { added += await upsertNormalized(n); } catch { /* skip */ }
      }
    }
    if (!data.has_more) break;
    page++; await sleep(DELAY_MS);
  }
  return { added, seen };
}

(async () => {
  if (!TOKEN || !QID || !process.env.DATABASE_URL) { console.error('Set RESUMLY_TOKEN, RESUMLY_QUERY_ID, DATABASE_URL'); process.exit(1); }
  let rows;
  if (ROLE_SOURCE === 'roles') {
    const { ALL_ROLES } = require('./resumly-roles');
    rows = ALL_ROLES.map((r) => ({ query_text: r, location: ROLE_LOCATION }));
  } else {
    ({ rows } = await query(
      `SELECT query_text, location FROM search_demand
         WHERE query_text IS NOT NULL AND query_text <> ''
         ORDER BY search_count DESC, last_result_count ASC NULLS FIRST LIMIT $1`, [DEMAND_LIMIT]));
  }
  // Resume: skip roles already checkpointed.
  const doneSet = new Set();
  try { fs.readFileSync(CHECKPOINT, 'utf8').split('\n').forEach((l) => l.trim() && doneSet.add(l.trim())); } catch { /* fresh */ }
  const pending = rows.filter((r) => !doneSet.has(`${r.query_text}|${r.location || ''}`));
  logger.info({ source: ROLE_SOURCE, total: rows.length, alreadyDone: doneSet.size, pending: pending.length }, 'resumly bulk drain starting');
  rows = pending;
  const t0 = Date.now();
  let totalAdded = 0, totalSeen = 0, done = 0;
  const bySource = {};
  for (const row of rows) {
    const titles = splitList(row.query_text, 5);
    const locs = splitList(row.location, 5);
    if (!titles.length) continue;
    try {
      const ok = await setQuery(titles, locs);
      if (!ok) { logger.warn({ q: row.query_text.slice(0, 40) }, 'query update failed — skip'); continue; }
      await sleep(2500); // let resumly populate the query
      const { added, seen } = await drainCurrentQuery();
      totalAdded += added; totalSeen += seen; done++;
      // Checkpoint ONLY on success, so a role that errored is retried on the next resume.
      try { fs.appendFileSync(CHECKPOINT, `${row.query_text}|${row.location || ''}\n`); } catch { /* ignore */ }
      logger.info({ role: row.query_text.slice(0, 40), loc: row.location, seen, added, cumAdded: totalAdded }, `role ${done}/${rows.length} drained`);
    } catch (e) {
      logger.warn({ role: row.query_text.slice(0, 40), err: e.message }, 'role failed — skipping (will retry on resume)');
    }
    await sleep(400);
  }
  // Restore the user's saved search.
  const rt = process.env.RESTORE_TITLE || 'financial analyst';
  const rl = process.env.RESTORE_LOCATION || 'United States';
  const restored = await setQuery([rt], [rl]);
  logger.info({ roles: done, seen: totalSeen, added: totalAdded, restored, minutes: ((Date.now() - t0) / 60000).toFixed(1) }, 'resumly bulk drain COMPLETE');
  await closeDb();
  process.exit(0);
})().catch((e) => { logger.error({ err: e.message, stack: e.stack }, 'resumly bulk drain fatal'); process.exit(1); });
