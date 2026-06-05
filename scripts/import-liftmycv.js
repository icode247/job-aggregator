#!/usr/bin/env node
/**
 * Pull jobs from LiftMyCV's search API and insert any that we don't already
 * have into the Heroku prod Postgres. LiftMyCV's records include full
 * descriptions, so no backfill needed.
 *
 * The LiftMyCV API caps result windows at offset 10000 (count × page ≤ 10000).
 * This script paginates count=100 page=1..100 to drain that window for a given
 * filter, then exits. To pull more, vary --workplace (ANY/REMOTE/HYBRID/ONSITE)
 * or --profile-id and re-run.
 *
 * Usage:
 *   DATABASE_URL=$(heroku config:get DATABASE_URL -a fastapply-board) \
 *     node scripts/import-liftmycv.js --workplace=ANY --dry-run
 *
 *   # Real run after reviewing dry-run output:
 *   DATABASE_URL=... node scripts/import-liftmycv.js --workplace=ANY
 *
 *   # Save the API response to a file for re-import (skip API on second run):
 *   DATABASE_URL=... node scripts/import-liftmycv.js --workplace=ANY \
 *     --save-dump=/tmp/lmc-any.json
 *
 *   # Replay from a saved dump (no API calls):
 *   DATABASE_URL=... node scripts/import-liftmycv.js --from=/tmp/lmc-any.json
 *
 * Flags:
 *   --workplace=ANY|REMOTE|HYBRID|ONSITE   API filter.          (default: ANY)
 *   --profile-id=N           LiftMyCV profileId in URL.         (default: 27552)
 *   --count=N                Page size for API requests.        (default: 100)
 *   --max-pages=N            Stop after N pages.                (default: 100 = the API cap)
 *   --save-dump=PATH         Save concatenated API responses to a JSON file.
 *   --from=PATH              Skip API; load jobs from a previous dump.
 *   --dry-run                Parse + dedupe but don't write to DB.
 */

'use strict';

const fs = require('fs');
const { Pool } = require('pg');

// ---------- argv ----------
const args = process.argv.slice(2);
const argFor = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const WORKPLACE = argFor('workplace', 'ANY');
const PROFILE   = argFor('profile-id', '27552');
const COUNT     = parseInt(argFor('count', '100'), 10);
const MAX_PAGES = parseInt(argFor('max-pages', '100'), 10);
const SAVE_DUMP = argFor('save-dump', null);
const FROM_FILE = argFor('from', null);
const DRY_RUN   = args.includes('--dry-run');

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set.');
  console.error('  hint: DATABASE_URL=$(heroku config:get DATABASE_URL -a fastapply-board) ...');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 4,
  connectionTimeoutMillis: 10000,
});

// Helper that accepts SQLite-style ? placeholders and translates to $1, $2 ...
// (matches the convention in src/db/connection.js so the SQL below stays readable)
async function query(sql, params = []) {
  let idx = 0;
  const pgSql = sql.replace(/\?/g, () => `$${++idx}`).replace(/datetime\('now'\)/gi, 'NOW()');
  return pool.query(pgSql, params);
}
async function closeDb() { await pool.end(); }

// ---------- util ----------
const banner = (s) => console.log('\n' + '═'.repeat(78) + '\n' + s + '\n' + '═'.repeat(78));
const sub    = (s) => console.log('\n── ' + s + ' ' + '─'.repeat(Math.max(0, 73 - s.length)));

// ---------- platform → ATS + URL parsers ----------
// Maps LiftMyCV's `platform` to our `ats` column, plus a parser that turns
// the jobUrl into { slug, externalId } matching the convention used elsewhere
// in this codebase. When externalId can't be reliably derived from the URL,
// fall back to a hash of the URL — dedup then falls back to URL-equality.

const PLATFORM_MAP = {
  ashby:           { ats: 'ashby',           parse: parseAshby },
  greenhouse:      { ats: 'greenhouse',      parse: parseGreenhouse },
  lever:           { ats: 'lever',           parse: parseLever },
  breezy:          { ats: 'breezy',          parse: parseBreezy },
  recruitee:       { ats: 'recruitee',       parse: parseRecruitee },
  smartrecruiters: { ats: 'smartrecruiters', parse: parseSmartRecruiters },
  jworkable:       { ats: 'workable',        parse: parseWorkableMarketplace },
  workable:        { ats: 'workable',        parse: parseWorkableApply },
};

function parseAshby(url) {
  // https://jobs.ashbyhq.com/{slug}/{uuid}[?...]
  const m = url.match(/jobs\.ashbyhq\.com\/([^/]+)\/([0-9a-f-]{36})/i);
  if (!m) return null;
  return { slug: m[1], externalId: `ashby_${m[2]}` };
}
function parseGreenhouse(url) {
  // job-boards[.eu].greenhouse.io/{slug}/jobs/{id}  OR  boards.greenhouse.io/{slug}/jobs/{id}
  // OR custom domain  ...?gh_jid={id}
  let m = url.match(/greenhouse\.io\/([^/]+)\/jobs\/(\d+)/i);
  if (m) return { slug: m[1], externalId: `greenhouse_${m[2]}` };
  m = url.match(/[?&]gh_jid=(\d+)/i);
  if (m) {
    const host = new URL(url).hostname.split('.').slice(-2).join('.');
    return { slug: host.split('.')[0], externalId: `greenhouse_${m[1]}` };
  }
  return null;
}
function parseLever(url) {
  const m = url.match(/jobs\.lever\.co\/([^/]+)\/([0-9a-f-]{36})/i);
  if (!m) return null;
  return { slug: m[1], externalId: `lever_${m[2]}` };
}
function parseBreezy(url) {
  // https://{slug}.breezy.hr/p/{hash}-{title}
  const m = url.match(/https?:\/\/([^.]+)\.breezy\.hr\/p\/([a-f0-9]+)/i);
  if (!m) return null;
  return { slug: m[1], externalId: `breezy_${m[2]}` };
}
function parseRecruitee(url) {
  // https://{slug}.recruitee.com/o/{title-slug}  (or custom domain → no slug)
  // Our existing rows use a numeric id which is NOT in the URL.
  // Best-effort: use the title-slug as part of the external_id. Dedup will fall
  // back to URL-match so this is OK even though it won't collide with the legacy
  // numeric format.
  const u = new URL(url);
  const slug = u.hostname.endsWith('.recruitee.com')
    ? u.hostname.replace(/\.recruitee\.com$/, '')
    : null;
  const m = u.pathname.match(/\/o\/(.+)$/);
  if (!m || !slug) return null;
  return { slug, externalId: `recruitee_slug_${m[1].replace(/\/+$/, '')}` };
}
function parseSmartRecruiters(url) {
  // https://jobs.smartrecruiters.com/{slug}/{numericId}-{title-slug}
  const m = url.match(/jobs\.smartrecruiters\.com\/([^/]+)\/(\d+)/i);
  if (!m) return null;
  return { slug: m[1], externalId: `smartrecruiters_${m[2]}` };
}
function parseWorkableMarketplace(url) {
  // https://jobs.workable.com/view/{shortcode}/{title}-at-{company}
  // Our existing workable rows use external_id "workable_mkt_{uuid}" where the
  // uuid is in our raw_data, not the URL. We can't recover that here, so use
  // the public shortcode instead. Dedup falls back to URL match.
  const m = url.match(/jobs\.workable\.com\/view\/([A-Za-z0-9]+)/);
  if (!m) return null;
  // For the company slug, fall back to extracting from URL tail.
  const titleMatch = url.match(/-at-([^/?#]+)/i);
  return {
    slug: (titleMatch ? titleMatch[1] : `workable-${m[1].slice(0, 8)}`).toLowerCase(),
    externalId: `workable_view_${m[1]}`,
  };
}
function parseWorkableApply(url) {
  // https://apply.workable.com/{slug}/j/{jobCode}/
  // Sync-time workable jobs are stored with external_id "workable_{jobCode}".
  // Verified one-shot recovery of ~667 rows that the jworkable parser missed.
  const m = url.match(/apply\.workable\.com\/([^/]+)\/j\/([A-Za-z0-9]+)\/?/i);
  if (!m) return null;
  return { slug: m[1], externalId: `workable_${m[2]}` };
}

// Career URL + domain for the company row. Best-effort per platform.
function companyForPlatform(ats, slug) {
  switch (ats) {
    case 'ashby':           return { careerUrl: `https://jobs.ashbyhq.com/${slug}`,             domain: 'jobs.ashbyhq.com' };
    case 'greenhouse':      return { careerUrl: `https://job-boards.greenhouse.io/${slug}`,     domain: 'job-boards.greenhouse.io' };
    case 'lever':           return { careerUrl: `https://jobs.lever.co/${slug}`,                domain: 'jobs.lever.co' };
    case 'breezy':          return { careerUrl: `https://${slug}.breezy.hr`,                    domain: `${slug}.breezy.hr` };
    case 'recruitee':       return { careerUrl: `https://${slug}.recruitee.com`,                domain: `${slug}.recruitee.com` };
    case 'smartrecruiters': return { careerUrl: `https://careers.smartrecruiters.com/${slug}`,  domain: 'careers.smartrecruiters.com' };
    case 'workable':        return { careerUrl: `https://jobs.workable.com/at/${slug}`,         domain: 'jobs.workable.com' };
    default:                return null;
  }
}

// ---------- API ----------
async function fetchPage(page) {
  const url = `https://app.liftmycv.com/api/v1/jobs/search?count=${COUNT}&page=${page}&workplaceType=${WORKPLACE}&profileId=${PROFILE}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { error: `HTTP ${res.status}`, body: body.slice(0, 200) };
  }
  const data = await res.json();
  return { jobs: data.results?.jobs || [], total: data.results?.total };
}

async function fetchPageWithRetry(page, max = 4) {
  for (let attempt = 0; attempt < max; attempt++) {
    try {
      return await fetchPage(page);
    } catch (err) {
      // Most likely TimeoutError. Backoff and retry.
      if (attempt < max - 1) {
        const wait = 1000 * Math.pow(2, attempt);
        process.stdout.write(`(timeout, retry in ${wait}ms) `);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      // Last attempt failed — surface as a sentinel error so fetchAll stops.
      return { error: `fetch failed after ${max} attempts: ${err.message || err}` };
    }
  }
}

async function fetchAll() {
  const all = [];
  let page = 1;
  let total = null;
  while (page <= MAX_PAGES) {
    process.stdout.write(`  fetching page ${page}... `);
    const r = await fetchPageWithRetry(page);
    if (r.error) {
      console.log(r.error + (r.body ? ' ' + r.body : '') + '  ← stopping (keeping what we have so far)');
      break;
    }
    if (r.total !== undefined) total = r.total;
    if (r.jobs.length === 0) {
      console.log('0 jobs — end of results');
      break;
    }
    console.log(`${r.jobs.length} jobs`);
    all.push(...r.jobs);
    if (r.jobs.length < COUNT) break;
    page++;
  }
  return { jobs: all, total, pagesFetched: page - 1 };
}

// ---------- DB ops ----------
async function findExistingByUrlOrExternalId(url, externalId) {
  // Either match counts as "we already have this".
  const { rows } = await query(
    `SELECT id FROM jobs WHERE removed_at IS NULL AND (url = ? OR external_id = ?) LIMIT 1`,
    [url, externalId]
  );
  return rows[0]?.id || null;
}

async function ensureCompany({ ats, slug, careerUrl, domain, companyName, logoUrl }) {
  // Best-effort: insert if missing; if exists, return the id.
  await query(
    `INSERT INTO companies (career_url, domain, ats, ats_slug, status, origin, last_discovered_at, company_name, logo_url)
     VALUES (?, ?, ?, ?, 'active', 'liftmycv', datetime('now'), ?, ?)
     ON CONFLICT(career_url) DO NOTHING`,
    [careerUrl, domain, ats, slug, companyName || null, logoUrl || null]
  );
  const { rows } = await query('SELECT id FROM companies WHERE career_url = ?', [careerUrl]);
  return rows[0]?.id || null;
}

async function insertJob(row) {
  await query(
    `INSERT INTO jobs (
       external_id, company_id, ats, title, description, url, location,
       workplace_type, employment_type, salary_min, salary_max,
       salary_currency, salary_interval, posted_at, raw_data
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(external_id, company_id) DO NOTHING`,
    [
      row.external_id, row.company_id, row.ats, row.title, row.description,
      row.url, row.location, row.workplace_type, row.employment_type,
      row.salary_min, row.salary_max, row.salary_currency,
      row.salary_interval, row.posted_at, row.raw_data,
    ]
  );
}

// ---------- normalize ----------
function normalize(record) {
  const platform = PLATFORM_MAP[record.platform];
  if (!platform) return { skip: `unsupported platform: ${record.platform}` };
  const parsed = platform.parse(record.jobUrl || '');
  if (!parsed) return { skip: `unparseable url: ${record.jobUrl}` };
  const company = companyForPlatform(platform.ats, parsed.slug);
  if (!company) return { skip: `no company shape for ats: ${platform.ats}` };

  // Map LiftMyCV's workplaceType to our convention
  const wt = (record.workplaceType || '').toLowerCase();
  const workplace_type = wt === 'remote' ? 'remote'
                       : wt === 'hybrid' ? 'hybrid'
                       : wt === 'onsite' || wt === 'on_site' ? 'onsite'
                       : null;

  // Salary
  const sal = record.salary || {};
  return {
    job: {
      ats:             platform.ats,
      external_id:     parsed.externalId,
      title:           record.role,
      description:     record.description || null,
      url:             record.jobUrl,
      // Truncate location — Postgres b-tree idx_jobs_location can't index
      // values larger than ~2700 bytes per row. Some LiftMyCV records have
      // multi-region comma-lists that blow past this. 1000 chars is plenty
      // for our ILIKE search and human display.
      location:        record.location ? String(record.location).slice(0, 1000) : null,
      workplace_type,
      employment_type: null,
      salary_min:      sal.min != null ? String(sal.min) : null,
      salary_max:      sal.max != null ? String(sal.max) : null,
      salary_currency: sal.currency || null,
      salary_interval: sal.period || sal.interval || null,
      posted_at:       record.jobCreatedAt
                         ? new Date(Math.round(record.jobCreatedAt * 1000)).toISOString()
                         : null,
      raw_data:        JSON.stringify(record),
    },
    company: { ...company, ats: platform.ats, slug: parsed.slug, companyName: record.company, logoUrl: record.logoUrl },
  };
}

// ---------- main ----------
async function main() {
  banner(`LiftMyCV → Heroku Postgres (prod)
  workplace:  ${WORKPLACE}
  profile-id: ${PROFILE}
  count/page: ${COUNT}
  max pages:  ${MAX_PAGES}
  source:     ${FROM_FILE ? 'file ' + FROM_FILE : 'live API'}
  dry-run:    ${DRY_RUN}`);

  // Load jobs from API or from a dump file
  let allJobs, total = null, pagesFetched = 0;
  if (FROM_FILE) {
    const payload = JSON.parse(fs.readFileSync(FROM_FILE, 'utf8'));
    allJobs = payload.jobs;
    total = payload.total;
    pagesFetched = payload.pagesFetched || 0;
    console.log(`  loaded ${allJobs.length} jobs from ${FROM_FILE} (total available at fetch time: ${total ?? 'unknown'})`);
  } else {
    sub('Fetching from API');
    const r = await fetchAll();
    allJobs = r.jobs;
    total = r.total;
    pagesFetched = r.pagesFetched;
    console.log(`\n  fetched ${allJobs.length} jobs over ${pagesFetched} pages (total available: ${total ?? 'unknown'})`);
    if (SAVE_DUMP) {
      fs.writeFileSync(SAVE_DUMP, JSON.stringify({ jobs: allJobs, total, pagesFetched, fetchedAt: new Date().toISOString() }));
      console.log(`  dumped to ${SAVE_DUMP}`);
    }
  }

  if (allJobs.length === 0) {
    console.log('\nNo jobs fetched — exiting.');
    await closeDb();
    return;
  }

  // Normalize + dedupe + insert
  sub('Processing');
  const stats = {
    fetched: allJobs.length,
    skipped_unparseable: 0,
    duplicate: 0,
    inserted: 0,
  };
  const platformCounts = {};

  for (let i = 0; i < allJobs.length; i++) {
    const rec = allJobs[i];
    platformCounts[rec.platform] = (platformCounts[rec.platform] || 0) + 1;

    const n = normalize(rec);
    if (n.skip) { stats.skipped_unparseable++; continue; }

    const existingId = await findExistingByUrlOrExternalId(n.job.url, n.job.external_id);
    if (existingId) { stats.duplicate++; continue; }

    if (DRY_RUN) { stats.inserted++; continue; }

    const companyId = await ensureCompany(n.company);
    if (!companyId) { stats.skipped_unparseable++; continue; }
    n.job.company_id = companyId;

    try {
      await insertJob(n.job);
      stats.inserted++;
    } catch (err) {
      // Don't let a single bad row (e.g. data too long for an index) kill the
      // whole run. Log and move on.
      stats.errors = (stats.errors || 0) + 1;
      if (stats.errors <= 10) {
        console.log(`    [err] ${n.job.external_id}: ${err.message.split('\n')[0]}`);
      }
    }

    // Progress every 250 jobs
    if ((i + 1) % 250 === 0) {
      console.log(`  processed ${i + 1}/${allJobs.length}  inserted=${stats.inserted}  dup=${stats.duplicate}  skip=${stats.skipped_unparseable}`);
    }
  }

  banner('SUMMARY');
  console.log(`  fetched:             ${stats.fetched}`);
  console.log(`  already in DB:       ${stats.duplicate}`);
  console.log(`  skipped (unparseable): ${stats.skipped_unparseable}`);
  console.log(`  newly inserted:      ${stats.inserted}${DRY_RUN ? '  (DRY RUN, no writes)' : ''}`);
  console.log(`\n  by platform (fetched):`);
  for (const [p, n] of Object.entries(platformCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)}  ${p}`);
  }
  console.log(`\n  API total available for this filter (${WORKPLACE}): ${total ?? 'unknown'}`);
  if (total && total > 10000) {
    console.log(`  ⚠ This filter has ${total} jobs but the API caps at 10K per filter.`);
    console.log(`     Run again with --workplace=REMOTE / HYBRID / ONSITE for more coverage.`);
  }

  await closeDb();
}

main().catch(async (err) => {
  console.error('FATAL:', err);
  try { await closeDb(); } catch {}
  process.exit(1);
});
