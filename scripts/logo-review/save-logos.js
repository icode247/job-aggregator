#!/usr/bin/env node
/**
 * Save the human-approved logos from the current batch.
 *
 *   node scripts/logo-review/save-logos.js <ids-file>
 *
 * <ids-file> holds the ids Clinton approved (any format — every #\d+ / bare number
 * is picked up). Looks each one up in data/logo/batch-review.json, writes logo_url
 * for the approved set, and marks the WHOLE batch as processed so the rejected
 * companies don't come back in a later batch.
 */
const fs = require('fs');
const { makePool, q, appendProcessed, readProcessed, isExpiring, REVIEW_JSON, BATCH_JSON } = require('./lib');

async function main() {
  const idsFile = process.argv[2];
  if (!idsFile) { console.error('usage: save-logos.js <ids-file>'); process.exit(1); }

  const requested = [...new Set((fs.readFileSync(idsFile, 'utf8').match(/\d+/g) || []))];
  const review = JSON.parse(fs.readFileSync(REVIEW_JSON, 'utf8'));
  const byId = new Map(review.map(r => [String(r.id), r]));

  let hits = requested.map(id => byId.get(id)).filter(Boolean);
  // Refuse signed URLs even when approved: they render fine on the review page and 403 a
  // few days later. Better no logo than a broken one.
  const expiring = hits.filter(h => isExpiring(h.logo_url));
  if (expiring.length) {
    hits = hits.filter(h => !isExpiring(h.logo_url));
    console.log(`REFUSED ${expiring.length} approved logo(s) with an expiring signed URL:`);
    for (const h of expiring.slice(0, 5)) console.log(`  #${h.id} ${h.company_name}`);
  }
  const missing = requested.filter(id => !byId.has(id));

  // A stale paste (ids from a previous batch) would silently save nothing and then
  // burn the current batch as "processed" — refuse instead of guessing.
  if (hits.length === 0) {
    console.error(`REFUSED: none of the ${requested.length} ids are in the current batch — stale save-list?`);
    process.exit(2);
  }

  const pool = makePool();
  try {
    const CHUNK = 100;
    let saved = 0;
    for (let i = 0; i < hits.length; i += CHUNK) {
      const slice = hits.slice(i, i + CHUNK);
      const values = slice.map((h, n) => `($${n * 2 + 1}::int, $${n * 2 + 2}::text)`).join(',');
      const params = slice.flatMap(h => [h.id, h.logo_url]);
      const res = await q(pool, `
        UPDATE companies SET logo_url = v.logo_url, updated_at = NOW()
          FROM (VALUES ${values}) AS v(id, logo_url)
         WHERE companies.id = v.id
      `, params);
      saved += res.rowCount;
    }

    // Everything shown this round is now decided — approved or not.
    const batch = JSON.parse(fs.readFileSync(BATCH_JSON, 'utf8'));
    const already = readProcessed();
    const fresh = batch.map(b => String(b.id)).filter(id => !already.has(id));
    if (fresh.length) appendProcessed(fresh);

    console.log(`SAVED ${saved} / requested ${requested.length}` + (missing.length ? ` (${missing.length} not in batch)` : ''));
    console.log(`processed set: +${fresh.length} -> ${already.size + fresh.length}`);
  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
