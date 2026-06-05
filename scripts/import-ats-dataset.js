#!/usr/bin/env node
/**
 * Generic ATS Apify-dataset importer. Reads one or more Apify-format JSON
 * dumps, normalizes each record based on its `source` field, and idempotently
 * upserts both the company and job rows into the production Postgres. Records
 * missing a description are fetched via the live `fetchDescription` flow.
 *
 * Supported sources today: ashby, bamboohr, breezy.
 * Add a new source by writing one PARSERS[<source>] function below — the rest
 * is identical for every ATS.
 *
 * Idempotent: companies are upserted by UNIQUE(career_url), jobs by
 * UNIQUE(external_id, company_id). Re-running with the same files is safe.
 *
 * Usage:
 *   DATABASE_URL=$(heroku config:get DATABASE_URL -a fastapply-board) \
 *     node scripts/import-ats-dataset.js FILE1.json [FILE2.json ...]
 *
 *   # Dry run (no DB writes):
 *   ... node scripts/import-ats-dataset.js --dry-run file1.json
 *
 *   # Skip description backfill phase:
 *   ... node scripts/import-ats-dataset.js --no-backfill file1.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { fetchDescription } = require('../src/tasks/backfill-descriptions');

const args = process.argv.slice(2);
const DRY_RUN     = args.includes('--dry-run');
const NO_BACKFILL = args.includes('--no-backfill');
// --skip-source=breezy,ashby — if a file contains ANY record with one of
// these sources, the whole file is skipped (safety guard when re-running
// against a mixed batch that includes already-imported sources).
const SKIP_SOURCES = (() => {
  const flag = args.find((a) => a.startsWith('--skip-source='));
  return flag ? new Set(flag.slice('--skip-source='.length).split(',').map((s) => s.trim()).filter(Boolean)) : new Set();
})();
const FILES = args.filter((a) => !a.startsWith('--'));

if (FILES.length === 0) {
  console.error('Usage: node scripts/import-ats-dataset.js [--dry-run] [--no-backfill] FILE1.json [...]');
  process.exit(1);
}
if (!process.env.DATABASE_URL) { console.error('ERROR: DATABASE_URL is not set.'); process.exit(1); }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,                          // small — leave room for worker + web
  connectionTimeoutMillis: 30000,  // tolerate slow Heroku PG handshakes
  idleTimeoutMillis: 10000,        // recycle quickly so stale conns get dropped
});
// Swallow pool-level errors (e.g. transient "connection terminated"); the
// per-query try/catch in withRetry will re-acquire and retry.
pool.on('error', (err) => { console.warn('  [pool warn]', err.message); });

async function withRetry(fn, label, max = 3) {
  let lastErr;
  for (let i = 0; i < max; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (i < max - 1) await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw new Error(`${label}: ${lastErr.message}`);
}

const banner = (s) => console.log('\n' + '═'.repeat(78) + '\n' + s + '\n' + '═'.repeat(78));
const sub    = (s) => console.log('\n── ' + s + ' ' + '─'.repeat(Math.max(0, 73 - s.length)));
const num    = (v) => (v == null || v === '') ? null : String(v);

// ---------- per-source URL parsers ----------
// Each parser returns: { ats, slug, externalId, url, careerUrl, domain }
// or null if the URL doesn't match the expected pattern.
const PARSERS = {
  ashby(url) {
    try {
      const u = new URL(url);
      if (u.hostname !== 'jobs.ashbyhq.com') return null;
      const m = u.pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/i);
      if (!m) return null;
      const [, slug, jobId] = m;
      return {
        ats: 'ashby',
        slug,
        externalId: `ashby_${jobId}`,
        url: `https://jobs.ashbyhq.com/${slug}/${jobId}`,
        careerUrl: `https://jobs.ashbyhq.com/${slug}`,
        domain: 'jobs.ashbyhq.com',
      };
    } catch { return null; }
  },

  bamboohr(url) {
    try {
      const u = new URL(url);
      if (!u.hostname.endsWith('.bamboohr.com')) return null;
      const slug = u.hostname.replace(/\.bamboohr\.com$/, '');
      const m = u.pathname.match(/\/careers\/(\d+)/);
      if (!m) return null;
      return {
        ats: 'bamboohr',
        slug,
        externalId: `bamboohr_${m[1]}`,
        url: `https://${slug}.bamboohr.com/careers/${m[1]}`,
        careerUrl: `https://${slug}.bamboohr.com/careers`,
        domain: `${slug}.bamboohr.com`,
      };
    } catch { return null; }
  },

  breezy(url) {
    try {
      const u = new URL(url);
      if (!u.hostname.endsWith('.breezy.hr')) return null;
      const slug = u.hostname.replace(/\.breezy\.hr$/, '');
      // Path: /p/<12hex>-<title-slug>
      const m = u.pathname.match(/^\/p\/([0-9a-f]+)/i);
      if (!m) return null;
      return {
        ats: 'breezy',
        slug,
        externalId: `breezy_${m[1]}`,
        url: `https://${slug}.breezy.hr${u.pathname}`,
        careerUrl: `https://${slug}.breezy.hr`,
        domain: `${slug}.breezy.hr`,
      };
    } catch { return null; }
  },

  smartrecruiters(url) {
    try {
      const u = new URL(url);
      if (u.hostname !== 'jobs.smartrecruiters.com') return null;
      // Path: /<slug>/<numericId>-<title-slug>[?...]
      const m = u.pathname.match(/^\/([^/]+)\/(\d+)/);
      if (!m) return null;
      const [, slug, jobId] = m;
      return {
        ats: 'smartrecruiters',
        slug,
        externalId: `smartrecruiters_${jobId}`,
        // Drop query string (apply_url often has ?oga=true) for canonical url
        url: `https://jobs.smartrecruiters.com${u.pathname}`,
        careerUrl: `https://careers.smartrecruiters.com/${slug}`,
        domain: 'careers.smartrecruiters.com',
      };
    } catch { return null; }
  },

  workable(url) {
    try {
      const u = new URL(url);
      // Variant A: https://apply.workable.com/<slug>/j/<jobCode>/
      if (u.hostname === 'apply.workable.com') {
        const m = u.pathname.match(/^\/([^/]+)\/j\/([A-Za-z0-9]+)\/?/i);
        if (!m) return null;
        const [, slug, jobCode] = m;
        return {
          ats: 'workable',
          slug,
          externalId: `workable_${jobCode}`,
          url: `https://apply.workable.com/${slug}/j/${jobCode}/`,
          careerUrl: `https://apply.workable.com/${slug}`,
          domain: 'apply.workable.com',
        };
      }
      // Variant B: https://jobs.workable.com/view/<shortcode>/<title>-at-<company>
      if (u.hostname === 'jobs.workable.com') {
        const m = u.pathname.match(/^\/view\/([A-Za-z0-9]+)/);
        if (!m) return null;
        const shortcode = m[1];
        // Pull company slug from URL tail "-at-<company>" if present, else
        // synthesize one from the shortcode prefix.
        let slug;
        const tailMatch = u.pathname.match(/-at-([^/?#]+)/i);
        slug = tailMatch ? tailMatch[1].toLowerCase() : `mkt-${shortcode.slice(0, 12).toLowerCase()}`;
        return {
          ats: 'workable',
          slug,
          externalId: `workable_mkt_${shortcode}`,
          url: `https://jobs.workable.com/view/${shortcode}`,
          careerUrl: `https://jobs.workable.com/view/${shortcode}`,
          domain: 'jobs.workable.com',
        };
      }
      return null;
    } catch { return null; }
  },

  jazzhr(url) {
    try {
      const u = new URL(url);
      if (!u.hostname.endsWith('.applytojob.com')) return null;
      const slug = u.hostname.replace(/\.applytojob\.com$/, '');
      // Path: /apply/<jobId>/<title>
      const m = u.pathname.match(/^\/apply\/([A-Za-z0-9]+)/);
      if (!m) return null;
      return {
        ats: 'jazzhr',
        slug,
        externalId: `jazzhr_${m[1]}`,
        url: `https://${slug}.applytojob.com/apply/${m[1]}`,
        careerUrl: `https://${slug}.applytojob.com`,
        domain: `${slug}.applytojob.com`,
      };
    } catch { return null; }
  },

  recruitee(url) {
    try {
      const u = new URL(url);
      // Path is /o/<title-slug> for both subdomain boards and custom-domain
      // boards (recruitee lets companies route their own DNS — e.g.
      // careers.acturis.com or transperfect.com pointing at recruitee).
      const m = u.pathname.match(/^\/o\/([^/?#]+)/);
      if (!m) return null;

      // Slug derivation:
      //   1. <slug>.recruitee.com → slug = subdomain
      //   2. custom domain → slug = bare second-level domain (strip "careers."/
      //      "jobs."/etc. prefixes and the TLD).
      let slug;
      if (u.hostname.endsWith('.recruitee.com')) {
        slug = u.hostname.replace(/\.recruitee\.com$/, '');
      } else {
        slug = u.hostname
          .replace(/^(careers?|jobs?|werkenbij|work|hiring|apply|recrutement|recruitment|talent|join)\./i, '')
          .split('.')[0];
      }
      return {
        ats: 'recruitee',
        slug,
        externalId: `recruitee_url_${m[1]}`,
        url: u.toString().split('?')[0],
        careerUrl: `https://${u.hostname}`,
        domain: u.hostname,
      };
    } catch { return null; }
  },

  // Add more sources here as needed. Each must return the same shape.
};

function normalize(record) {
  const parser = PARSERS[record.source];
  if (!parser) return { error: `unsupported source: ${record.source}` };

  const parsed = parser(record.listing_url || record.apply_url);
  if (!parsed) return { error: `${record.source}: unparseable URL: ${record.listing_url}` };

  const description = typeof record.description === 'string' && record.description.trim()
    ? record.description
    : null;
  const location = Array.isArray(record.locations) && record.locations[0]?.location
    ? record.locations[0].location
    : null;
  const comp = record.compensation || {};

  return {
    job: {
      external_id:     parsed.externalId,
      ats:             parsed.ats,
      title:           record.title,
      description,
      url:             parsed.url,
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
    company: { ats: parsed.ats, careerUrl: parsed.careerUrl, domain: parsed.domain, slug: parsed.slug },
  };
}

// ---------- DB ops (identical for every source) ----------
async function upsertCompany({ ats, careerUrl, domain, slug }) {
  if (DRY_RUN) return -1;
  const { rows } = await pool.query(
    `INSERT INTO companies (career_url, domain, ats, ats_slug, status, origin, last_discovered_at)
     VALUES ($1, $2, $3, $4, 'active', 'apify-import', NOW())
     ON CONFLICT (career_url) DO UPDATE SET
       ats        = COALESCE(companies.ats, EXCLUDED.ats),
       ats_slug   = COALESCE(companies.ats_slug, EXCLUDED.ats_slug),
       status     = CASE WHEN companies.status IN ('pending','failed') THEN 'active' ELSE companies.status END,
       updated_at = NOW()
     RETURNING id`,
    [careerUrl, domain, ats, slug],
  );
  return rows[0].id;
}

async function upsertJob(jobRow, companyId) {
  if (DRY_RUN) return { action: 'dry-run', id: -1, hadDescription: !!jobRow.description };
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

async function backfillMissingDescriptions(jobIds) {
  if (jobIds.length === 0) return { filled: 0, skipped: 0, failed: 0 };
  console.log(`  Probing ${jobIds.length} just-inserted jobs lacking a description...`);
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

async function main() {
  banner(`ATS dataset import
  files:        ${FILES.length}
  dry-run:      ${DRY_RUN ? 'YES' : 'no'}
  backfill:     ${NO_BACKFILL ? 'skipped' : 'enabled'}
  supported:    ${Object.keys(PARSERS).join(', ')}`);

  const records = [];
  let skippedFiles = 0;
  for (const file of FILES) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Defensive skip: if any record matches a --skip-source value, drop the whole file.
    if (SKIP_SOURCES.size > 0) {
      const offendingSrc = data.find((r) => SKIP_SOURCES.has(r.source))?.source;
      if (offendingSrc) {
        console.log(`  ${path.basename(file)}: SKIPPED (contains source="${offendingSrc}")`);
        skippedFiles++;
        continue;
      }
    }
    console.log(`  ${path.basename(file)}: ${data.length} records`);
    for (const r of data) records.push(r);
  }
  console.log(`  Total raw records: ${records.length}` + (skippedFiles ? `  (${skippedFiles} files skipped)` : ''));

  sub('Normalizing');
  const normalized = [];
  const errCounts = {};
  for (const r of records) {
    const n = normalize(r);
    if (n.error) {
      errCounts[n.error.split(':')[0]] = (errCounts[n.error.split(':')[0]] || 0) + 1;
      continue;
    }
    normalized.push(n);
  }
  console.log(`  OK: ${normalized.length}   errors: ${records.length - normalized.length}`);
  for (const [k, v] of Object.entries(errCounts)) console.log(`    ${v}× ${k}`);

  // Tally by source
  const bySource = {};
  for (const n of normalized) bySource[n.job.ats] = (bySource[n.job.ats] || 0) + 1;
  console.log('  by source: ' + Object.entries(bySource).map(([k, v]) => `${k}=${v}`).join(', '));

  sub('Upserting companies');
  // Cache by (ats, slug) — different ATSes can theoretically share a slug
  const companyIds = new Map();
  for (const n of normalized) {
    const key = `${n.company.ats}:${n.company.slug}`;
    if (companyIds.has(key)) continue;
    const id = await withRetry(() => upsertCompany(n.company), `upsertCompany(${key})`);
    companyIds.set(key, id);
  }
  console.log(`  ${companyIds.size} distinct companies handled`);

  sub('Upserting jobs');
  const counts = { inserted: 0, updated: 0, dryRun: 0, errors: 0 };
  const missingDescIds = [];
  for (const n of normalized) {
    const companyId = companyIds.get(`${n.company.ats}:${n.company.slug}`);
    let result;
    try {
      result = await withRetry(() => upsertJob(n.job, companyId), `upsertJob(${n.job.external_id})`);
    } catch (err) {
      counts.errors++;
      if (counts.errors <= 5) console.log(`    [err] ${n.job.external_id}: ${err.message}`);
      continue;
    }
    counts[result.action === 'inserted' ? 'inserted'
         : result.action === 'updated' ? 'updated'
         : 'dryRun']++;
    if (!result.hadDescription && result.id > 0) missingDescIds.push(result.id);
  }
  console.log(`  inserted: ${counts.inserted}   updated: ${counts.updated}` +
              (counts.errors ? `   errors: ${counts.errors}` : '') +
              (DRY_RUN ? `   dry-run: ${counts.dryRun}` : ''));
  console.log(`  missing-description rows queued for backfill: ${missingDescIds.length}`);

  if (!NO_BACKFILL && !DRY_RUN && missingDescIds.length > 0) {
    sub('Backfilling descriptions');
    const bf = await backfillMissingDescriptions(missingDescIds);
    console.log(`  filled:  ${bf.filled}`);
    console.log(`  skipped: ${bf.skipped}   → marked N/A`);
    console.log(`  failed:  ${bf.failed}`);
  }

  banner('DONE');
  await pool.end();
}

main().catch((err) => { console.error('FATAL:', err); pool.end().catch(() => {}); process.exit(1); });
