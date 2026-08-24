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
// How many consecutive all-unfillable batches to walk past before giving up on a platform.
// 25 x 75 rows = ~1,875 dead rows tolerated, comfortably more than the largest wall measured.
const MAX_EMPTY_ROUNDS = parseInt(process.env.MAX_EMPTY_ROUNDS || '25', 10);
const LOOP = process.env.LOOP === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }
  const atsList = process.argv.slice(2).filter(Boolean);
  if (!atsList.length) { console.error('Usage: backfill-desc-generic.js <ats> [ats...]'); process.exit(1); }

  do {
    for (const ats of atsList) {
      const cfg = ATS_CONFIG[ats] || { batchSize: 75, concurrency: 4 };
      let totFill = 0, totFail = 0, rounds = 0, emptyStreak = 0, walked = 0;
      while (true) {
        const { checked, filled, failed } = await backfillForAts(ats, cfg.batchSize, cfg.concurrency);

        // A batch that returned NO ROWS is the real end of the candidate set — stop.
        if (checked === 0) break;
        walked += checked;

        // A batch that returned rows but filled none is a WALL, not the end.
        //
        // The old code broke here, and on oraclecloud that cost ~800 fillable descriptions:
        // the cursor walks ascending id, the oldest rows are dead requisitions, and the first
        // batch of 75 filled zero — so the drain stopped at round 1 while newer rows behind the
        // wall were 63% alive (measured 2026-08-24: first 30 by id = 28 dead / 0 alive, last 30
        // = 11 dead / 19 alive). Walking past it is exactly what the cursor was built for.
        if (filled === 0) {
          if (++emptyStreak >= MAX_EMPTY_ROUNDS) {
            console.log(`[${ats}] ${emptyStreak} empty rounds (${walked} rows walked) — stopping`);
            break;
          }
          // Say something while crossing the wall. Silently walking up to 25 unproductive
          // batches makes a healthy run look wedged — the same trap the workday prune sweep hit
          // before it grew a heartbeat, and the reason that run was killed by hand for no cause.
          console.log(`[${ats}] ...walking: ${emptyStreak} empty round(s), ${walked} rows checked, none fillable`);
          continue;
        }
        emptyStreak = 0;
        totFill += filled; totFail += failed; rounds++;
        console.log(`[${ats}] round ${rounds}: +${filled} filled, +${failed} failed | total ${totFill}/${totFill + totFail}`);
      }
      console.log(`[${ats}] drained: ${totFill} filled, ${totFail} failed, ${walked} rows walked`);
    }
    if (LOOP) { console.log(`--- sleeping ${RECHECK_S}s before re-check ---`); await sleep(RECHECK_S * 1000); }
  } while (LOOP);

  await closeDb();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
