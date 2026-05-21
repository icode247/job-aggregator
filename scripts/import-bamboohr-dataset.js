#!/usr/bin/env node
/**
 * Import a dataset of BambooHR jobs into the production DB, then backfill
 * descriptions for any rows that landed without one.
 *
 * Idempotent: re-running is safe — companies are upserted by ats+ats_slug
 * (via UNIQUE(career_url)) and jobs by UNIQUE(external_id, company_id).
 *
 * Usage:
 *   DATABASE_URL=$(heroku config:get DATABASE_URL -a fastapply-board) \
 *     node scripts/import-bamboohr-dataset.js \
 *       /path/to/dataset1.json /path/to/dataset2.json
 *
 *   # Dry run (no writes):
 *   ... node scripts/import-bamboohr-dataset.js --dry-run file1.json
 *
 *   # Skip description backfill (just import):
 *   ... node scripts/import-bamboohr-dataset.js --no-backfill file1.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { fetchDescription } = require('../src/tasks/backfill-descriptions');

const args = process.argv.slice(2);
const DRY_RUN     = args.includes('--dry-run');
const NO_BACKFILL = args.includes('--no-backfill');
const FILES       = args.filter((a) => !a.startsWith('--'));

if (FILES.length === 0) {
  console.error('Usage: node scripts/import-bamboohr-dataset.js [--dry-run] [--no-backfill] FILE1.json [FILE2.json ...]');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 4,
  connectionTimeoutMillis: 10000,
});

const banner = (s) => console.log('\n' + '═'.repeat(78) + '\n' + s + '\n' + '═'.repeat(78));
const sub    = (s) => console.log('\n── ' + s + ' ' + '─'.repeat(Math.max(0, 73 - s.length)));

// ---------- record normalization ----------

/**
 * Parse a BambooHR listing_url into { slug, careerNum }.
 *   https://spacemanager.bamboohr.com/careers/57 → { slug: 'spacemanager', careerNum: '57' }
 */
function parseBambooUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('.bamboohr.com')) return null;
    const slug = u.hostname.replace(/\.bamboohr\.com$/, '');
    const m = u.pathname.match(/\/careers\/(\d+)/);
    if (!m) return null;
    return { slug, careerNum: m[1] };
  } catch { return null; }
}

/** Coerce a numeric salary value to a TEXT-friendly representation. */
const num = (v) => (v == null || v === '') ? null : String(v);

/** Convert dataset record → row to upsert. Returns null if unprocessable. */
function normalize(record) {
  if (record.source !== 'bamboohr') return { error: `unsupported source: ${record.source}` };

  const parsed = parseBambooUrl(record.listing_url || record.apply_url);
  if (!parsed) return { error: `unparseable URL: ${record.listing_url}` };

  const { slug, careerNum } = parsed;
  const url = `https://${slug}.bamboohr.com/careers/${careerNum}`;
  const careerUrl = `https://${slug}.bamboohr.com/careers`;
  const domain = `${slug}.bamboohr.com`;

  // file 2 has top-level `description`. file 1 doesn't (just `summary`).
  // We leave `description` NULL when only summary is available so the
  // backfill step downloads the canonical HTML body.
  const description = typeof record.description === 'string' && record.description.trim()
    ? record.description
    : null;

  // locations is an array of {location, city, region, country, ...}. Use first.
  const location = Array.isArray(record.locations) && record.locations[0]?.location
    ? record.locations[0].location
    : null;

  const comp = record.compensation || {};

  return {
    job: {
      external_id:     `bamboohr_${careerNum}`,
      ats:             'bamboohr',
      title:           record.title,
      description,
      url,
      location,
      workplace_type:  record.workplace_type || null,
      employment_type: record.employment_type || null,
      salary_min:      num(comp.min),
      salary_max:      num(comp.max),
      salary_currency: comp.currency || null,
      salary_interval: comp.period || null,
      posted_at:       record.date_posted || record.created_at || null,
      raw_data:        JSON.stringify(record),
    },
    company: { careerUrl, domain, slug },
  };
}

// ---------- DB ops ----------

/** Upsert a company; return its id. */
async function upsertCompany({ careerUrl, domain, slug }) {
  // Try insert, fall back to select on conflict
  if (DRY_RUN) return -1;
  const { rows } = await pool.query(
    `INSERT INTO companies (career_url, domain, ats, ats_slug, status, origin, last_discovered_at)
     VALUES ($1, $2, 'bamboohr', $3, 'active', 'apify-import', NOW())
     ON CONFLICT (career_url) DO UPDATE SET
       ats        = COALESCE(companies.ats, EXCLUDED.ats),
       ats_slug   = COALESCE(companies.ats_slug, EXCLUDED.ats_slug),
       status     = CASE WHEN companies.status IN ('pending','failed') THEN 'active' ELSE companies.status END,
       updated_at = NOW()
     RETURNING id`,
    [careerUrl, domain, slug],
  );
  return rows[0].id;
}

/** Upsert a job; return {action: 'inserted'|'updated'|'unchanged', id, hadDescription}. */
async function upsertJob(jobRow, companyId) {
  if (DRY_RUN) return { action: 'dry-run', id: -1, hadDescription: !!jobRow.description };

  // First check if exists, and whether it already has a description we shouldn't clobber
  const { rows: existing } = await pool.query(
    `SELECT id, description FROM jobs WHERE external_id = $1 AND company_id = $2`,
    [jobRow.external_id, companyId],
  );

  if (existing.length === 0) {
    const { rows } = await pool.query(
      `INSERT INTO jobs (
         external_id, company_id, ats, title, description, url, location,
         workplace_type, employment_type, salary_min, salary_max,
         salary_currency, salary_interval, posted_at, raw_data
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [
        jobRow.external_id, companyId, jobRow.ats, jobRow.title, jobRow.description,
        jobRow.url, jobRow.location, jobRow.workplace_type, jobRow.employment_type,
        jobRow.salary_min, jobRow.salary_max, jobRow.salary_currency,
        jobRow.salary_interval, jobRow.posted_at, jobRow.raw_data,
      ],
    );
    return { action: 'inserted', id: rows[0].id, hadDescription: !!jobRow.description };
  }

  // Exists — update metadata but don't overwrite a non-null description with null.
  // Mark last_seen_at so the stale-cleanup doesn't reap it.
  const existingDesc = existing[0].description;
  const finalDesc = jobRow.description || existingDesc;
  await pool.query(
    `UPDATE jobs SET
       title = $1, url = $2, location = $3,
       workplace_type = $4, employment_type = $5,
       salary_min = $6, salary_max = $7,
       salary_currency = $8, salary_interval = $9,
       posted_at = COALESCE($10, posted_at),
       raw_data = $11,
       description = $12,
       last_seen_at = NOW(),
       removed_at = NULL
     WHERE id = $13`,
    [
      jobRow.title, jobRow.url, jobRow.location,
      jobRow.workplace_type, jobRow.employment_type,
      jobRow.salary_min, jobRow.salary_max,
      jobRow.salary_currency, jobRow.salary_interval,
      jobRow.posted_at, jobRow.raw_data, finalDesc,
      existing[0].id,
    ],
  );
  return { action: 'updated', id: existing[0].id, hadDescription: !!finalDesc };
}

// ---------- backfill (uses real fetcher) ----------
async function backfillMissingDescriptions(jobIds) {
  if (jobIds.length === 0) return { filled: 0, skipped: 0, failed: 0 };
  console.log(`  Probing ${jobIds.length} just-inserted jobs lacking a description...`);

  // Concurrency 4 (matches the live worker's reduced concurrency)
  const CONCURRENCY = 4;
  const queue = [...jobIds];
  const stats = { filled: 0, skipped: 0, failed: 0 };

  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      const { rows } = await pool.query(
        `SELECT j.id, j.ats, j.external_id, j.url, j.raw_data, c.ats_slug
           FROM jobs j JOIN companies c ON j.company_id = c.id
          WHERE j.id = $1`,
        [id],
      );
      if (!rows[0]) { stats.failed++; continue; }
      let result;
      try { result = await fetchDescription(rows[0]); }
      catch { stats.failed++; continue; }

      if (typeof result === 'string' && result !== 'SKIP') {
        await pool.query('UPDATE jobs SET description = $1 WHERE id = $2', [result, id]);
        stats.filled++;
      } else if (result === 'SKIP') {
        await pool.query("UPDATE jobs SET description = 'N/A' WHERE id = $1", [id]);
        stats.skipped++;
      } else {
        stats.failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return stats;
}

// ---------- main ----------
async function main() {
  banner(`BambooHR dataset import
  files:     ${FILES.length}
  dry-run:   ${DRY_RUN ? 'YES' : 'no'}
  backfill:  ${NO_BACKFILL ? 'skipped' : 'enabled'}`);

  // Load + normalize all records up front
  const records = [];
  for (const file of FILES) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(`  ${path.basename(file)}: ${data.length} records`);
    for (const r of data) records.push(r);
  }
  console.log(`  Total raw records: ${records.length}`);

  sub('Normalizing');
  const normalized = [];
  let errors = 0;
  for (const r of records) {
    const n = normalize(r);
    if (n.error) { errors++; console.log(`    skip: ${n.error}`); continue; }
    normalized.push(n);
  }
  console.log(`  OK: ${normalized.length}   errors: ${errors}`);

  // Cache company ids by slug to avoid round-trips
  sub('Upserting companies');
  const companyIds = new Map();
  for (const n of normalized) {
    if (companyIds.has(n.company.slug)) continue;
    const id = await upsertCompany(n.company);
    companyIds.set(n.company.slug, id);
  }
  console.log(`  ${companyIds.size} distinct companies handled`);

  sub('Upserting jobs');
  const counts = { inserted: 0, updated: 0, dryRun: 0 };
  const missingDescIds = [];
  for (const n of normalized) {
    const companyId = companyIds.get(n.company.slug);
    const result = await upsertJob(n.job, companyId);
    counts[result.action === 'inserted' ? 'inserted'
         : result.action === 'updated' ? 'updated'
         : 'dryRun']++;
    if (!result.hadDescription && result.id > 0) missingDescIds.push(result.id);
  }
  console.log(`  inserted: ${counts.inserted}   updated: ${counts.updated}` +
              (DRY_RUN ? `   dry-run: ${counts.dryRun}` : ''));
  console.log(`  missing-description rows queued for backfill: ${missingDescIds.length}`);

  // Backfill descriptions
  if (!NO_BACKFILL && !DRY_RUN && missingDescIds.length > 0) {
    sub('Backfilling descriptions');
    const bf = await backfillMissingDescriptions(missingDescIds);
    console.log(`  filled:  ${bf.filled}`);
    console.log(`  skipped: ${bf.skipped}   → marked N/A`);
    console.log(`  failed:  ${bf.failed}    ← still null, worker will retry`);
  }

  banner('DONE');
  await pool.end();
}

main().catch((err) => {
  console.error('FATAL:', err);
  pool.end().catch(() => {});
  process.exit(1);
});
