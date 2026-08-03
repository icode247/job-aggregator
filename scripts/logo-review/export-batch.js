#!/usr/bin/env node
/**
 * Export the next batch of logo-less companies for review.
 *
 *   node scripts/logo-review/export-batch.js [size]        # default 500
 *
 * Picks companies with no logo, ordered by live job count (highest user-visible
 * impact first), skipping anything already reviewed (data/logo/processed.txt).
 * Writes data/logo/batch-companies.json + batch-websites.csv (scraper input).
 */
const fs = require('fs');
const { makePool, q, readProcessed, BATCH_JSON, BATCH_CSV } = require('./lib');

const SIZE = parseInt(process.argv[2] || '500', 10);
// Pull a wide window so the already-reviewed ids can be filtered out in JS and we
// still land a full batch.
const WINDOW = Math.max(8000, SIZE * 16);

async function main() {
  const pool = makePool();
  try {
    const processed = readProcessed();
    // Skip companies whose `domain` is a shared ATS host (recruiting.paylocity.com,
    // apply.workable.com, boards.greenhouse.io, ...). Scraping those returns the ATS's
    // own branding, so every company behind one host gets handed the same wrong image.
    // ~23.6k of the logo-less pool sits here and needs real-website discovery instead.
    const { rows } = await q(pool, `
      SELECT c.id, c.company_name, c.domain, COUNT(j.id)::int AS jobs
        FROM companies c
        JOIN jobs j ON j.company_id = c.id AND j.removed_at IS NULL
       WHERE c.logo_url IS NULL
         AND c.domain IS NOT NULL AND c.domain <> ''
         AND c.domain NOT IN (SELECT domain FROM companies GROUP BY domain HAVING COUNT(*) > 1)
       GROUP BY c.id
       ORDER BY jobs DESC
       LIMIT $1
    `, [WINDOW]);

    const batch = rows.filter(r => !processed.has(String(r.id))).slice(0, SIZE);
    if (!batch.length) {
      console.log('EXPORTED 0 — nothing left in the window');
      return;
    }

    fs.writeFileSync(BATCH_JSON, JSON.stringify(batch, null, 2));
    fs.writeFileSync(BATCH_CSV, 'website\n' + batch.map(r => r.domain).join('\n') + '\n');
    console.log(`EXPORTED ${batch.length} (jobs ${batch[0].jobs} -> ${batch[batch.length - 1].jobs})`);
  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
