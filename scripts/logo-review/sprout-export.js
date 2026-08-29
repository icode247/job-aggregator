#!/usr/bin/env node
/**
 * Turn Sprout matches into a normal review batch.
 *
 *   PROCESSED_FILE=data/logo/processed-sprout2.txt \
 *     node scripts/logo-review/sprout-export.js [size]
 *
 * Reads data/logo/sprout-matched.json (from sprout-analyse.js) and writes the same two
 * files the scrapers produce — batch-companies.json and batch-logos.csv — so
 * build-preview.js and save-logos.js run unchanged and every logo still gets eyeballed.
 *
 * There is no scraping here: the logo URL came from Sprout's own API, so the "scrape" step
 * is already done. What this does add is a liveness check, because a URL that 404s renders
 * as an empty card and wastes a review slot.
 *
 * JOIN KEY: build-preview matches CSV rows to companies on scrape_target/domain/career_url,
 * and drops any key claimed by more than one company. Real domains collide here — several
 * matched companies share an ATS host, and two rows can even share a logo URL. So each row
 * gets a synthetic `sprout://<id>` key that is unique by construction. The company's real
 * domain still travels in `domain` for display.
 */
const fs = require('fs');
const path = require('path');
const { BATCH_JSON, SCRAPED_CSV, PROCESSED, readProcessed, makePool, q, isExpiring } = require('./lib');

const ROOT = path.resolve(__dirname, '../..');
const MATCHED = path.join(ROOT, 'data', 'logo', 'sprout-matched.json');
const SIZE = Math.max(1, parseInt(process.argv[2] || '150', 10));
const CONC = 12;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

async function alive(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(url, { method: 'GET', headers: { 'user-agent': UA }, signal: ctl.signal });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 200;             // a few-byte body is not a logo
  } catch { return false; } finally { clearTimeout(timer); }
}

async function main() {
  const all = JSON.parse(fs.readFileSync(MATCHED, 'utf8'));
  const done = readProcessed();
  console.log(`matched pool: ${all.length} | already reviewed: ${done.size}`);

  // Belt and braces: analyse already drops expiring URLs, but this is the last gate before
  // a human sees a card, and an expiring URL is the one failure this pipeline cannot see.
  const queue = all.filter(r => !done.has(String(r.id)) && !isExpiring(r.logo_url));
  if (!queue.length) {
    console.log('EXPORTED 0 — Sprout queue is empty, all matches reviewed');
    process.exit(3);
  }

  // Over-fetch so dead URLs don't shrink the batch below the requested size.
  const probe = queue.slice(0, SIZE * 2);
  const ok = [];
  let next = 0, checked = 0, dead = 0;
  const worker = async () => {
    while (next < probe.length && ok.length < SIZE) {
      const r = probe[next++];
      if (await alive(r.logo_url)) ok.push(r); else dead++;
      if (++checked % 50 === 0) console.log(`  ${checked} checked, ${ok.length} live, ${dead} dead`);
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));

  const batch = ok.slice(0, SIZE);
  if (!batch.length) {
    console.log(`EXPORTED 0 — probed ${checked}, none of the logo URLs are live`);
    process.exit(3);
  }

  // Job counts are display-only. One indexed EXISTS-style lookup for the batch, never a
  // COUNT over the whole jobs table — that shape has taken this database down before.
  const counts = new Map();
  try {
    const pool = makePool();
    const r = await q(pool, `SELECT company_id, COUNT(*)::int AS n FROM jobs
                             WHERE removed_at IS NULL AND company_id = ANY($1)
                             GROUP BY company_id`, [batch.map(b => b.id)]);
    for (const row of r.rows) counts.set(row.company_id, row.n);
    await pool.end();
  } catch (err) {
    console.log(`  (job counts unavailable: ${err.message.slice(0, 60)} — continuing without them)`);
  }

  const companies = batch.map(r => ({
    id: r.id,
    company_name: r.company_name,
    domain: `sprout: ${r.sprout_name}`,
    career_url: null,
    ats: 'sprout',
    jobs: counts.get(r.id) || 0,
    scrape_target: `sprout://${r.id}`,
    // Shown on the card. 'slug' is the strong key (same ATS board on both sides);
    // 'exact'/'loose' matched on company NAME only and deserve a harder look.
    slug_match: r.matched_by === 'slug',
    matched_by: r.matched_by,
  }));

  const quote = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const rows = batch.map(r => [`sprout://${r.id}`, r.logo_url, 'img-logo', 'ok']);
  fs.writeFileSync(BATCH_JSON, JSON.stringify(companies, null, 2));
  fs.writeFileSync(SCRAPED_CSV,
    [['website', 'logo_url', 'logo_type', 'status'], ...rows].map(r => r.map(quote).join(',')).join('\n') + '\n');

  const tiers = batch.reduce((a, r) => (a[r.matched_by] = (a[r.matched_by] || 0) + 1, a), {});
  console.log(`EXPORTED ${batch.length} (probed ${checked}, ${dead} dead URLs skipped) | ` +
    `matched by ${JSON.stringify(tiers)} | queue remaining ~${queue.length - checked}`);
  console.log(`processed file: ${PROCESSED}`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
