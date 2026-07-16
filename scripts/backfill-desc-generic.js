#!/usr/bin/env node
/**
 * Loop the maintained per-ATS description backfill (backfill-descriptions.js's
 * backfillForAts) for the given non-IP-blocked ATS until each is drained, then
 * re-check on an interval to catch new nulls as discovery/crawl lands more jobs.
 *
 * Reuses the existing per-ATS detail fetchers (rippling, breezy, recruitee, ...).
 * NOTE: workable is IP-blocked — use scripts/backfill-workable-desc-proxy.sh for it.
 *
 * Run: DATABASE_URL=... node scripts/backfill-desc-generic.js rippling breezy
 * Env: LOOP=1 keep re-checking every RECHECK_S (default 480s); omit for one drain.
 */
const { backfillForAts, ATS_CONFIG } = require('../src/tasks/backfill-descriptions');
const { closeDb } = require('../src/db/connection');

const RECHECK_S = parseInt(process.env.RECHECK_S || '480', 10);
const LOOP = process.env.LOOP === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }
  const atsList = process.argv.slice(2).filter(Boolean);
  if (!atsList.length) { console.error('Usage: backfill-desc-generic.js <ats> [ats...]'); process.exit(1); }

  do {
    for (const ats of atsList) {
      const cfg = ATS_CONFIG[ats] || { batchSize: 75, concurrency: 4 };
      let totFill = 0, totFail = 0, rounds = 0;
      while (true) {
        const { filled, failed } = await backfillForAts(ats, cfg.batchSize, cfg.concurrency);
        // Stop when a round makes NO progress: either nothing left, or only
        // permanently-unfetchable jobs remain (expired/removed detail pages).
        // Retrying those forever just spins — leave them for the next LOOP pass.
        if (filled === 0) break;
        totFill += filled; totFail += failed; rounds++;
        console.log(`[${ats}] round ${rounds}: +${filled} filled, +${failed} failed | total ${totFill}/${totFill + totFail}`);
      }
      console.log(`[${ats}] drained: ${totFill} filled, ${totFail} failed`);
    }
    if (LOOP) { console.log(`--- sleeping ${RECHECK_S}s before re-check ---`); await sleep(RECHECK_S * 1000); }
  } while (LOOP);

  await closeDb();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
