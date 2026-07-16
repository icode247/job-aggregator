#!/usr/bin/env node
/**
 * Backfill missing BambooHR job descriptions. The adapter fetches descriptions
 * inline during sync, but under the discovery-crawl surge many /detail calls get
 * rate-limited and land as description=null. This re-fetches them, gently.
 *
 * Not IP-blocked (no proxy) but rate-sensitive — low concurrency + delay so it
 * doesn't re-trigger BambooHR's throttle (or compound instance A's crawl).
 *
 * Run: DATABASE_URL=... node scripts/backfill-bamboohr-desc.js
 * Env: WK... no. BH_CONCURRENCY(3), BH_DELAY_MS(250), BH_BATCH(300).
 */
const { query, closeDb } = require('../src/db/connection');

const CONC = parseInt(process.env.BH_CONCURRENCY || '3', 10);
const DELAY = parseInt(process.env.BH_DELAY_MS || '250', 10);
const BATCH = parseInt(process.env.BH_BATCH || '300', 10);
const q = async (s, p) => { for (let i = 0; i < 8; i++) { try { return await query(s, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 2500 * (i + 1))); } } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchDesc(slug, jobId) {
  try {
    const res = await fetch(`https://${slug}.bamboohr.com/careers/${jobId}/detail`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { status: res.status };
    const data = await res.json();
    return { desc: data.result?.jobOpening?.description || null };
  } catch (e) { return { err: e.message }; }
}

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }
  let filled = 0, empty = 0, failed = 0, round = 0;
  while (true) {
    const { rows } = await q(
      `SELECT j.id, j.external_id, c.ats_slug
         FROM jobs j JOIN companies c ON c.id = j.company_id
        WHERE j.ats = 'bamboohr' AND j.removed_at IS NULL
          AND (j.description IS NULL OR j.description = '')
        ORDER BY j.first_seen_at DESC
        LIMIT ?`, [BATCH]);
    if (!rows.length) { console.log(`No more bamboohr jobs need descriptions. filled ${filled}, empty ${empty}, failed ${failed}`); break; }
    round++;
    let i = 0, rFail = 0;
    await Promise.all(Array.from({ length: CONC }, async () => {
      while (i < rows.length) {
        const job = rows[i++];
        const jobId = job.external_id.replace('bamboohr_', '');
        const r = await fetchDesc(job.ats_slug, jobId);
        if (r.desc) { await q('UPDATE jobs SET description = ? WHERE id = ?', [r.desc, job.id]); filled++; }
        else if (r.desc === null && !r.err && !r.status) { empty++; }
        else { failed++; rFail++; }
        if (DELAY) await sleep(DELAY);
      }
    }));
    console.log(`round ${round}: batch ${rows.length} | total filled ${filled}, empty ${empty}, failed ${failed}${rFail > rows.length * 0.5 ? ' [high fail — throttling more]' : ''}`);
    if (rFail > rows.length * 0.5) await sleep(15000); // back off if BambooHR is throttling hard
  }
  await closeDb();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
