#!/usr/bin/env node
/**
 * Repair Workday career_urls that are missing the wdN instance.
 *
 *   DRY=1 node scripts/fix-workday-career-urls.js
 *   node scripts/fix-workday-career-urls.js
 *
 * Rows seeded from the older slug dump stored `https://{tenant}.myworkdayjobs.com`, which
 * omits the wdN instance every Workday tenant actually lives on — so the host does not
 * resolve at all. Crawling is unaffected (src/adapters/workday.js probes robots.txt to find
 * the instance), but anything that uses career_url directly gets a dead link: that is what
 * made every Workday company fail the logo render.
 *
 * The correct URLs come from the ats-scrapers tenant list, matched on tenant slug.
 * career_url is UNIQUE, so a tenant whose correct URL is already taken by another row is
 * skipped rather than allowed to abort the batch.
 */
const fs = require('fs');
const { query, closeDb } = require('../src/db/connection');

const CSV = process.env.CSV || '/Users/codev/ats-scrapers/ats-companies/workday.csv';
const DRY = process.env.DRY === '1';
const GOOD = /\.wd\d+\.myworkdayjobs\.com/i;

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
  return rows.filter(r => r.some(v => v !== ''))
    .map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
}

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }

  const byTenant = new Map();
  for (const r of parseCsv(fs.readFileSync(CSV, 'utf8'))) {
    const tenant = String(r.slug || '').split('/')[0].toLowerCase();
    if (tenant && GOOD.test(r.url)) byTenant.set(tenant, r.url);
  }
  console.log(`csv provides a valid URL for ${byTenant.size} tenants`);

  const { rows: broken } = await query(
    `SELECT id, ats_slug, career_url FROM companies
      WHERE ats = 'workday' AND career_url !~ '\\.wd[0-9]+\\.myworkdayjobs\\.com'`);
  console.log(`workday rows with a dead career_url: ${broken.length}`);

  // career_url is UNIQUE — don't try to move a row onto a URL another row already holds.
  const { rows: takenRows } = await query('SELECT career_url FROM companies');
  const taken = new Set(takenRows.map(r => r.career_url));

  const fixes = [];
  let noMatch = 0, collision = 0;
  for (const r of broken) {
    const url = byTenant.get(String(r.ats_slug || '').toLowerCase());
    if (!url) { noMatch++; continue; }
    if (taken.has(url)) { collision++; continue; }
    taken.add(url);
    fixes.push([r.id, url]);
  }

  console.log(`repairable: ${fixes.length} | no CSV entry: ${noMatch} | URL already taken: ${collision}`);
  if (DRY) {
    fixes.slice(0, 5).forEach(([id, u]) => console.log(`  #${id} -> ${u}`));
    await closeDb();
    return;
  }

  let updated = 0;
  for (let i = 0; i < fixes.length; i += 200) {
    const slice = fixes.slice(i, i + 200);
    const values = slice.map((f, n) => `($${n * 2 + 1}::int, $${n * 2 + 2}::text)`).join(',');
    const res = await query(
      `UPDATE companies SET career_url = v.url, updated_at = NOW()
         FROM (VALUES ${values}) AS v(id, url)
        WHERE companies.id = v.id`, slice.flat());
    updated += res.rowCount;
  }
  console.log(`UPDATED ${updated}`);
  await closeDb();
})().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
