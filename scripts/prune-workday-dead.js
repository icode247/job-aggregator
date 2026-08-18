#!/usr/bin/env node
/**
 * One-off sweep: retire Workday postings that are gone from their boards.
 *
 * The rotating pruner (scripts/prune-dead-jobs-local.js) now detects these correctly, but it
 * works the whole corpus at ~5k/cycle and the Workday backlog alone was measured at ~537k rows
 * on 2026-08-17 (46.7% of 1.15M live Workday jobs). This walks that backlog directly.
 *
 * Every removal is HTTP-verified at the moment of removal by checkUrl() — the same function and
 * the same "only ever remove on a confirmed dead response" rule the rotating pruner uses. A job
 * that answers 403/404/410 on its CXS endpoint right now is gone right now; timeouts, 5xx, 422
 * and network errors are all left alone.
 *
 *   SHADOW=1  report what would be removed, write nothing  (ALWAYS run this first)
 *   LIMIT     rows per batch                               (default 2000)
 *   BATCHES   how many batches to run, 0 = until exhausted (default 0)
 *   CONCURRENCY  parallel HTTP checks                      (default 8)
 *
 * CONCURRENCY defaults to 8 for the same reason the rotating pruner does: the binding constraint
 * on this Mac is SOCKETS, not database cost. 25-way concurrency once held 129 open sockets with
 * 351 in TIME_WAIT and macOS then refused new outbound connections, taking three crawlers down
 * with `read EADDRNOTAVAIL`. The crawlers are the higher-value work.
 *
 * Usage:
 *   SHADOW=1 DATABASE_URL=... node scripts/prune-workday-dead.js
 *   DATABASE_URL=... node scripts/prune-workday-dead.js
 */
const { checkUrl, runWithConcurrency } = require('../src/tasks/dead-job-check');
const { query } = require('../src/db/connection');

const SHADOW = process.env.SHADOW === '1';
const LIMIT = parseInt(process.env.LIMIT || '2000', 10);
const BATCHES = parseInt(process.env.BATCHES || '0', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '8', 10);

// Cursor, not OFFSET: rows leave the candidate set as they are retired, so an OFFSET walk would
// skip a growing window of unchecked rows. Ascending id only ever moves forward.
//
// Persisted, because this is a ~40-hour walk over a 28GB table and the candidate query does
// time out occasionally — the first run died at batch 4 on `Query read timeout`. Restarting from
// zero is correct but wasteful: already-retired rows are filtered out by `removed_at IS NULL`,
// so a restart only re-checks the LIVE rows it already cleared, and those are the expensive ones
// (a live job costs a full HTTP round trip to confirm). The file lives outside /tmp, which is
// wiped on reboot.
const fs = require('fs');
const path = require('path');
const CURSOR_FILE = process.env.CURSOR_FILE
  || path.join(process.env.HOME || '.', '.fastapply-workday-prune-cursor');

function loadCursor() {
  try { return parseInt(fs.readFileSync(CURSOR_FILE, 'utf8').trim(), 10) || 0; } catch { return 0; }
}
function saveCursor(id) {
  try { fs.writeFileSync(CURSOR_FILE, String(id)); } catch { /* progress only — never fatal */ }
}

let cursor = loadCursor();

// Upper bound of the id space, read once at startup off the primary key (~200ms).
let maxId = 0;

// The candidate set is walked as ID WINDOWS, not as `ORDER BY id LIMIT n`.
//
// The sorted form is what killed the first run. `WHERE removed_at IS NULL AND ats='workday'
// AND id > ? ORDER BY id LIMIT 2000` has no index that satisfies both the filter and the order:
// idx_jobs_ats_active covers (ats) WHERE removed_at IS NULL but says nothing about id order, and
// idx_jobs_desc_backfill (ats, id) is partial on `description IS NULL` so this query cannot use
// it. Postgres therefore sorted ~1.15M matching rows per batch and timed out at 120s, every
// time. Same ORDER BY trap that took out all four worker loops before.
//
// A half-open id window needs no sort at all — it is a primary-key range scan with a filter:
//
//   WHERE id > lo AND id <= lo + window AND removed_at IS NULL AND ats='workday'
//
// Measured against the exact range the sorted query died on: 214-296ms versus a 120s timeout.
//
// The window SIZE has to adapt, because workday rows are wildly unevenly distributed across the
// id space — essentially none below id 68M, then a few hundred per 23M through the middle, and
// the great bulk above 183M where the bulk imports minted their ids. One fixed size is either
// glacial through the empty stretches or returns an unmanageable batch in the dense ones. So the
// window grows when a range comes back sparse and fast, and shrinks when it comes back dense or
// slow. TARGET_ROWS is the batch size we actually want to hand to the HTTP checkers.
const TARGET_ROWS = LIMIT;
const MIN_WINDOW = 25_000;
const MAX_WINDOW = 50_000_000;
let windowSize = parseInt(process.env.WINDOW || '500000', 10);
let lastHeartbeat = 0;

async function batch() {
  let jobs = null;
  // Skip forward through empty stretches without handing an empty batch back to the caller;
  // otherwise a sparse region ends the run early as if the candidate set were exhausted.
  while (cursor < maxId) {
    const lo = cursor;
    const hi = Math.min(lo + windowSize, maxId);
    const started = Date.now();
    let rows;
    try {
      ({ rows } = await query(
        `SELECT id, url FROM jobs
          WHERE id > ? AND id <= ?
            AND removed_at IS NULL AND ats = 'workday'`,
        [lo, hi]
      ));
    } catch (err) {
      // A window too big to finish is a sizing problem, not a failure — shrink and retry it.
      if (windowSize > MIN_WINDOW) {
        windowSize = Math.max(MIN_WINDOW, Math.floor(windowSize / 4));
        console.log(`  window ${lo}..${hi} failed (${err.message.slice(0, 40)}) — shrinking to ${windowSize}`);
        continue;
      }
      throw err;
    }
    const elapsed = Date.now() - started;
    cursor = hi;
    saveCursor(cursor);

    // Re-tune for the next window.
    if (rows.length > TARGET_ROWS * 1.5 || elapsed > 20000) {
      windowSize = Math.max(MIN_WINDOW, Math.floor(windowSize / 2));
    } else if (rows.length < TARGET_ROWS / 4 && elapsed < 5000) {
      windowSize = Math.min(MAX_WINDOW, windowSize * 2);
    }

    if (rows.length) { jobs = rows; break; }

    // Windows holding no workday rows are skipped silently, which made a healthy run look
    // wedged: the dense upper half of the id space is ~100x slower to scan per id (a window
    // there reads every row of every ATS and filters), so the loop can spend many minutes
    // between batches with nothing to say. Heartbeat at most every 30s so progress stays
    // visible without flooding the log during the fast, empty lower half.
    if (Date.now() - lastHeartbeat > 30000) {
      lastHeartbeat = Date.now();
      console.log(`  ...scanning: cursor=${cursor} (${(100 * cursor / maxId).toFixed(1)}%) `
        + `window=${windowSize} last=${elapsed}ms empty`);
    }
  }
  if (!jobs) return null;

  const dead = [];
  let alive = 0, uncertain = 0;
  await runWithConcurrency(jobs, CONCURRENCY, async (job) => {
    const r = await checkUrl(job.url);
    if (r.alive === false) dead.push(job.id);
    else if (r.alive === null) uncertain++;
    else alive++;
  });

  if (dead.length && !SHADOW) {
    // Sorted, 500 at a time, with a breath between chunks. Both columns are indexed and this is
    // a 28GB table with 26 indexes that eleven crawlers are writing to continuously: one big
    // UPDATE is the shape that has starved the live API before, and unordered row visits between
    // concurrent writers deadlock by definition. Ascending id can only ever wait, never cycle.
    const sorted = [...dead].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 0; i < sorted.length; i += 500) {
      await query(
        `UPDATE jobs SET removed_at = NOW() WHERE id IN (
           SELECT id FROM jobs WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE
         )`,
        [sorted.slice(i, i + 500)]
      );
      if (i + 500 < sorted.length) await new Promise((r) => setTimeout(r, 250));
    }
  }
  return { checked: jobs.length, dead: dead.length, alive, uncertain };
}

(async () => {
  console.log(`${SHADOW ? 'SHADOW (no writes)' : 'ARMED (will set removed_at)'} — limit=${LIMIT} concurrency=${CONCURRENCY}`);
  // Off the primary key, so this is ~200ms even under crawl load.
  ({ rows: [{ hi: maxId }] } = await query('SELECT MAX(id) AS hi FROM jobs'));
  maxId = Number(maxId);
  console.log(`resuming from cursor ${cursor} of ${maxId} (${(100 * cursor / maxId).toFixed(1)}%), window ${windowSize}`);
  let n = 0, totChecked = 0, totDead = 0, totAlive = 0, totUncertain = 0;
  let consecutiveErrors = 0;
  const started = Date.now();
  while (BATCHES === 0 || n < BATCHES) {
    let r;
    try {
      r = await batch();
      consecutiveErrors = 0;
    } catch (err) {
      // The candidate scan competes with eleven crawlers writing to the same table, so a read
      // timeout here is congestion, not a bug — back off and retry rather than abandoning a
      // multi-hour walk. Give up only if it never recovers.
      if (++consecutiveErrors >= 10) throw err;
      const backoff = Math.min(60, 5 * consecutiveErrors);
      console.log(`[${new Date().toISOString()}] batch error (${consecutiveErrors}/10): ${err.message} — retrying in ${backoff}s`);
      await new Promise((res) => setTimeout(res, backoff * 1000));
      continue;
    }
    if (!r) { console.log('candidate set exhausted'); break; }
    n++; totChecked += r.checked; totDead += r.dead; totAlive += r.alive; totUncertain += r.uncertain;
    const mins = (Date.now() - started) / 60000;
    console.log(
      `[${new Date().toISOString()}] batch ${n} checked=${r.checked} dead=${r.dead} alive=${r.alive} ` +
      `uncertain=${r.uncertain} | total dead=${totDead}/${totChecked} (${(100 * totDead / totChecked).toFixed(1)}%) ` +
      `${Math.round(totChecked / Math.max(mins, 0.01))}/min ` +
      `cursor=${cursor} (${(100 * cursor / maxId).toFixed(1)}%) window=${windowSize}`
    );
    // Breathing room for the crawlers' sockets and the API's database.
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`\ndone: checked=${totChecked} dead=${totDead} alive=${totAlive} uncertain=${totUncertain}` +
    (SHADOW ? '  (SHADOW — nothing was written)' : ''));
  process.exit(0);
})().catch((err) => { console.error('fatal:', err.message); process.exit(1); });
