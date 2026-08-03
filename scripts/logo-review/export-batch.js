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

// SHARED=1 flips to the companies whose `domain` is a shared ATS host. They have no
// own-domain page to scrape, but each has a unique branded careers page — rendered by
// scripts/logo-review/render-scrape.js. Restricted to the ATS that actually publish a
// per-company logo: Workday career_urls in the DB are malformed (missing the wdN
// subdomain, so DNS fails) and Workable/Comeet boards only ever show vendor art.
const SHARED = process.env.SHARED === '1';
const SHARED_ATS = ['paylocity', 'rippling', 'smartrecruiters', 'ashby', 'bamboohr', 'greenhouse', 'grnhse', 'successfactors'];

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
    const { rows } = SHARED
      ? await q(pool, `
          SELECT c.id, c.company_name, c.domain, c.career_url, c.ats, COUNT(j.id)::int AS jobs
            FROM companies c
            JOIN jobs j ON j.company_id = c.id AND j.removed_at IS NULL
           WHERE c.logo_url IS NULL
             AND c.career_url IS NOT NULL AND c.career_url <> ''
             AND c.ats = ANY($2)
             AND c.domain IN (SELECT domain FROM companies GROUP BY domain HAVING COUNT(*) > 1)
           GROUP BY c.id
           ORDER BY jobs DESC
           LIMIT $1
        `, [WINDOW, SHARED_ATS])
      : await q(pool, `
          SELECT c.id, c.company_name, c.domain, c.career_url, c.ats, COUNT(j.id)::int AS jobs
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
    // What the scraper is pointed at, and what build-preview joins the results back on.
    for (const r of batch) r.scrape_target = SHARED ? r.career_url : r.domain;
    if (!batch.length) {
      console.log('EXPORTED 0 — nothing left in the window');
      return;
    }

    fs.writeFileSync(BATCH_JSON, JSON.stringify(batch, null, 2));
    fs.writeFileSync(BATCH_CSV, 'website\n' + batch.map(r => r.scrape_target).join('\n') + '\n');
    console.log(`EXPORTED ${batch.length} (jobs ${batch[0].jobs} -> ${batch[batch.length - 1].jobs})`);
  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
