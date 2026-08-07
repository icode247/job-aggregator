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
// still land a full batch. The window is ordered by job count, so once enough of the
// high-job companies have been reviewed it fills up entirely with processed ids and
// returns a near-empty batch while thousands of unreviewed ones sit further down the
// tail — indistinguishable from a genuinely empty queue. Widen until the batch fills
// or the query stops returning a full window (which means we have seen everything).
const WINDOW = Math.max(8000, SIZE * 16);
const MAX_WINDOW = 200000;

async function main() {
  const pool = makePool();
  try {
    const processed = readProcessed();
    // Skip companies whose `domain` is a shared ATS host (recruiting.paylocity.com,
    // apply.workable.com, boards.greenhouse.io, ...). Scraping those returns the ATS's
    // own branding, so every company behind one host gets handed the same wrong image.
    // ~23.6k of the logo-less pool sits here and needs real-website discovery instead.
    const fetchWindow = async (limit) => SHARED
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
        `, [limit, SHARED_ATS])
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
        `, [limit]);

    let window = WINDOW, rows = [], batch = [];
    for (;;) {
      ({ rows } = await fetchWindow(window));
      batch = rows.filter(r => !processed.has(String(r.id))).slice(0, SIZE);
      // A short batch is only meaningful if the window wasn't full — otherwise the
      // remainder is simply below the cut.
      if (batch.length >= SIZE || rows.length < window || window >= MAX_WINDOW) break;
      window = Math.min(window * 4, MAX_WINDOW);
      console.log(`  window saturated with reviewed ids, widening to ${window}`);
    }
    // What the scraper is pointed at, and what build-preview joins the results back on.
    for (const r of batch) r.scrape_target = SHARED ? r.career_url : r.domain;
    if (!batch.length) {
      console.log(`EXPORTED 0 — queue is genuinely empty (scanned ${rows.length} rows, all reviewed)`);
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
