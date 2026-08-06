#!/usr/bin/env node
/**
 * One-off: prove the index is reachable, create it with settings, and seed it.
 *
 * Must run from inside Render — Meilisearch is a private service with no public URL, which is
 * deliberate (its whole auth model is a single master key). That also means MEILI_HOST cannot
 * be verified from a laptop; this script is how we find out whether the host and port are right.
 *
 * Seeding marks rows dirty in keyset batches rather than one 4.5M-row UPDATE. The single-
 * transaction version of exactly this shape sat in IO/DataFileRead for 27 minutes on
 * 2026-08-05 and drove the API to ~30% 5xx; batches with pauses ran with zero errors.
 *
 *   node scripts/meili-init.js --probe        # health + settings only, writes nothing
 *   node scripts/meili-init.js --seed         # mark all live jobs for indexing, batched
 *
 * Env: SEED_BATCH(25000) SEED_PAUSE_MS(1000)
 */
const { query, closeDb } = require('../src/db/connection');
const meili = require('../src/utils/meili');

const SEED_BATCH = parseInt(process.env.SEED_BATCH || '25000', 10);
const SEED_PAUSE_MS = parseInt(process.env.SEED_PAUSE_MS || '1000', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const mode = process.argv.includes('--seed') ? 'seed' : 'probe';
  console.log(`mode=${mode} host=${meili.HOST || '(unset)'} index=${meili.INDEX} enabled=${meili.enabled}`);

  // --seed only marks rows in Postgres; the worker's sync loop is what talks to the index.
  // So the seed can run from anywhere, including a laptop that cannot reach the private
  // service. Only --probe genuinely needs connectivity.
  if (mode === 'probe') {
    if (!meili.enabled) {
      console.error('MEILI_HOST is not set — nothing to probe');
      process.exit(1);
    }
    const h = await meili.health();
    console.log('health:', JSON.stringify(h));
    if (!h.ok) {
      console.error('index unreachable — check MEILI_HOST host:port and that both services are in the same region');
      process.exit(1);
    }
    console.log('applying index settings...');
    await meili.ensureIndex();
    console.log('settings applied');
    console.log('index stats:', JSON.stringify(await meili.stats().catch(() => null)));
    await closeDb();
    return;
  }

  // Seed: mark live jobs dirty so the normal sync loop ships them. Marking rather than pushing
  // directly keeps one code path responsible for indexing, so a failed seed self-heals.
  await query('SET statement_timeout = 0');
  let from = 0, marked = 0, batches = 0;
  for (;;) {
    // Walk the primary key, do not filter on index_dirty_at IS NULL.
    //
    // idx_jobs_index_dirty is a PARTIAL index covering only non-null rows — it is the work
    // queue, not a copy of the table — so `WHERE index_dirty_at IS NULL` cannot use it and
    // degenerates into a scan that starts from the beginning each batch. Measured: selecting
    // 25k rows that way took 87s of a 113s batch, and would have got worse every batch.
    // Keyset-walking id uses the primary key and stays flat.
    const res = await query(
      `WITH batch AS (
         SELECT id FROM jobs
          WHERE id > ${from} AND removed_at IS NULL
          ORDER BY id LIMIT ${SEED_BATCH}
       )
       UPDATE jobs SET index_dirty_at = COALESCE(index_dirty_at, NOW())
        WHERE id IN (SELECT id FROM batch)
       RETURNING id`
    );
    if (!res.rowCount) break;
    from = res.rows.reduce((m, r) => Math.max(m, Number(r.id)), from);
    marked += res.rowCount;
    batches++;
    if (batches % 10 === 0) console.log(`  marked=${marked} batches=${batches} lastId=${from}`);
    await sleep(SEED_PAUSE_MS);
  }
  console.log(`seed complete: ${marked} rows marked in ${batches} batches`);
  await closeDb();
})().catch((err) => { console.error('meili-init failed:', err.message); process.exit(1); });
