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
let cursor = 0;

async function batch() {
  const { rows: jobs } = await query(
    `SELECT id, url FROM jobs
      WHERE removed_at IS NULL AND ats = 'workday' AND id > ?
      ORDER BY id
      LIMIT ?`,
    [cursor, LIMIT]
  );
  if (!jobs.length) return null;
  cursor = jobs[jobs.length - 1].id;

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
  let n = 0, totChecked = 0, totDead = 0, totAlive = 0, totUncertain = 0;
  const started = Date.now();
  while (BATCHES === 0 || n < BATCHES) {
    const r = await batch();
    if (!r) { console.log('candidate set exhausted'); break; }
    n++; totChecked += r.checked; totDead += r.dead; totAlive += r.alive; totUncertain += r.uncertain;
    const mins = (Date.now() - started) / 60000;
    console.log(
      `[${new Date().toISOString()}] batch ${n} checked=${r.checked} dead=${r.dead} alive=${r.alive} ` +
      `uncertain=${r.uncertain} | total dead=${totDead}/${totChecked} (${(100 * totDead / totChecked).toFixed(1)}%) ` +
      `${Math.round(totChecked / Math.max(mins, 0.01))}/min cursor=${cursor}`
    );
    // Breathing room for the crawlers' sockets and the API's database.
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`\ndone: checked=${totChecked} dead=${totDead} alive=${totAlive} uncertain=${totUncertain}` +
    (SHADOW ? '  (SHADOW — nothing was written)' : ''));
  process.exit(0);
})().catch((err) => { console.error('fatal:', err.message); process.exit(1); });
