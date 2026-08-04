#!/usr/bin/env node
/**
 * Seed companies from the ats-scrapers tenant lists (/Users/codev/ats-scrapers/ats-companies/{ats}.csv,
 * schema `name,slug,url`).
 *
 *   DRY=1 node scripts/import-ats-companies-csv.js          # report only
 *   node scripts/import-ats-companies-csv.js                # write
 *   ATS=greenhouse,lever node scripts/import-ats-companies-csv.js
 *
 * Only ATS we have a working adapter for, and only in the slug FORMAT that adapter's
 * fetchJobs() expects — a row written in the wrong shape is worse than no row, because the
 * crawler will claim it, fail, and keep retrying. Dedup is on (ats, ats_slug) against what
 * is already stored so we never create a second company for the same tenant (which would
 * double-crawl it and duplicate its jobs).
 *
 * Deliberately excluded, with cause:
 *   personio — adapter hardcodes {slug}.jobs.personio.de; this list is mostly .com hosts
 *   oracle   — Fusion tenants need the separate fetcher, still pending
 *   taleo    — legacy two-column file (the "slug" column holds a full URL)
 *   everything else in the directory (adp, avature, phenom, ...) has no adapter
 */
const fs = require('fs');
const path = require('path');
const { query, closeDb } = require('../src/db/connection');

const DIR = process.env.CSV_DIR || '/Users/codev/ats-scrapers/ats-companies';
const DRY = process.env.DRY === '1';
const ONLY = (process.env.ATS || '').split(',').map(s => s.trim()).filter(Boolean);

const host = u => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };

// file -> { ats, slug(row) -> crawlable slug, url(row, slug) -> canonical career_url }
const MAP = {
  ashby:           { ats: 'ashby' },
  bamboohr:        { ats: 'bamboohr' },
  breezy:          { ats: 'breezy' },
  greenhouse:      { ats: 'greenhouse' },
  jazzhr:          { ats: 'jazzhr' },
  lever:           { ats: 'lever' },
  paylocity:       { ats: 'paylocity' },
  pinpoint:        { ats: 'pinpoint' },
  recruitee:       { ats: 'recruitee' },
  rippling:        { ats: 'rippling' },
  smartrecruiters: { ats: 'smartrecruiters' },
  teamtailor:      { ats: 'teamtailor' },
  workable:        { ats: 'workable' },
  // The adapter keys off the host prefix, not the scraper's own slug.
  icims:           { ats: 'icims', slug: r => host(r.url).replace(/\.icims\.com$/, ''), url: (r, s) => `https://${s}.icims.com` },
  successfactors:  { ats: 'successfactors', slug: r => host(r.url) },
  // Slug is the bare tenant — src/adapters/workday.js probes robots.txt to discover the
  // wdN instance and site slug itself. Keep the CSV's full URL as career_url though: rows
  // seeded earlier stored `https://{tenant}.myworkdayjobs.com`, which has no wdN and so
  // fails DNS outright for anything that reads career_url directly.
  workday:         { ats: 'workday', slug: r => String(r.slug || '').split('/')[0] },
};

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map(h => h.trim().toLowerCase());
  // Pad short rows rather than dropping them. icims.csv declares a trailing
  // `company_name` column that most rows simply omit — filtering on column count
  // silently discarded 2,090 of its 2,498 tenants.
  return rows
    .filter(r => r.some(v => v !== ''))
    .map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
}

async function insertChunk(rows) {
  if (!rows.length || DRY) return 0;
  const vals = [], params = [];
  rows.forEach((r, i) => {
    const b = i * 6;
    vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},'active',$${b + 6},NOW(),NOW())`);
    params.push(r.name || null, r.domain, r.ats, r.slug, r.careerUrl, 'atscsv');
  });
  const res = await query(
    `INSERT INTO companies (company_name,domain,ats,ats_slug,career_url,status,origin,created_at,updated_at)
       VALUES ${vals.join(',')}
     ON CONFLICT (career_url) DO NOTHING
     RETURNING id`, params);
  return res.rowCount;
}

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }

  const files = Object.keys(MAP).filter(f => !ONLY.length || ONLY.includes(f));
  let grandNew = 0, grandSkip = 0, grandBad = 0;
  const report = [];

  for (const file of files) {
    const cfg = MAP[file];
    const csvPath = path.join(DIR, `${file}.csv`);
    if (!fs.existsSync(csvPath)) { console.log(`  ${file}: no file, skipped`); continue; }

    // Existing tenants for this ATS — dedup key is (ats, ats_slug).
    const { rows: existing } = await query(
      'SELECT LOWER(ats_slug) AS s FROM companies WHERE ats = $1 AND ats_slug IS NOT NULL', [cfg.ats]);
    const have = new Set(existing.map(r => r.s));

    const seen = new Set();
    const fresh = [];
    let bad = 0, dupe = 0;

    for (const r of parseCsv(fs.readFileSync(csvPath, 'utf8'))) {
      const slug = (cfg.slug ? cfg.slug(r) : r.slug || '').trim();
      const careerUrl = (cfg.url ? cfg.url(r, slug) : r.url || '').trim();
      const domain = host(careerUrl);
      if (!slug || !careerUrl || !domain) { bad++; continue; }
      const key = slug.toLowerCase();
      if (have.has(key) || seen.has(key)) { dupe++; continue; }
      seen.add(key);
      fresh.push({ name: r.name, domain, ats: cfg.ats, slug, careerUrl });
    }

    let inserted = 0;
    for (let i = 0; i < fresh.length; i += 500) inserted += await insertChunk(fresh.slice(i, i + 500));

    grandNew += DRY ? fresh.length : inserted;
    grandSkip += dupe;
    grandBad += bad;
    report.push({ ats: cfg.ats, new: DRY ? fresh.length : inserted, already: dupe, unusable: bad });
  }

  console.table(report);
  console.log(`${DRY ? '[DRY] would add' : 'added'}: ${grandNew} | already had: ${grandSkip} | unusable rows: ${grandBad}`);
  await closeDb();
})().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
