/**
 * Ship changed jobs into the search index.
 *
 * Driven by the index_dirty_at outbox column (see src/db/schema.js). A trigger sets it on every
 * insert and on any update that touches an indexed field, which is the only way to catch all
 * ~30 writers — several of them are one-off scripts running on a laptop that will never import
 * application code, and `jobs` has no updated_at to poll on.
 *
 * Claims a batch, ships it, then clears the flag only for rows whose index_dirty_at has not
 * moved since the claim. If a writer re-dirties a row mid-flight, the flag stays set and the
 * row is picked up again — losing an update is worse than shipping one twice, and Meilisearch
 * upserts on primary key so a duplicate costs nothing.
 *
 * Soft-deleted rows (removed_at set) are deleted from the index rather than indexed, so the
 * board never surfaces a dead posting.
 */
const { query } = require('../db/connection');
const meili = require('../utils/meili');
const logger = require('../logger');

// Ceiling on how fast this loop can push documents at Meilisearch.
//
// These were 1000 x 20 = 20,000 documents per tick (the tick re-arms 60s after the previous one
// finishes). On 2026-08-08 a 615k-row bulk import dirtied the outbox, this loop ran flat out to
// drain it, and the Meilisearch service — 2GB on Render — was OOM-killed three times in half an
// hour. Each kill takes the index offline; jobs-search.js then returns null and /api/jobs falls
// back to Postgres, where the same query cannot beat the statement timeout on 5M rows. So an
// indexing burst surfaces to users as a failing search endpoint.
//
// RAISED 2026-08-25, from 4 batches to 12, because the constraint the cap was sized against no
// longer exists. Everything above describes Meilisearch on Render's STANDARD plan: 2GB of RAM and
// ONE cpu. It now runs Pro Plus — 8GB and 4 cpus — so the memory ceiling that caused those three
// OOM kills is four times higher and indexing no longer competes with search for a single core.
//
// The cap had stopped being a safety margin and become the bottleneck. Measured before the
// change: the drain hit its 2,000-document ceiling on cycle after cycle (2000, 2000, 1923, 1834,
// 1629, 1582 ...), which means the outbox was saturated, not merely busy. That backlog has a
// user-visible consequence — the trigger fires on removed_at, so a RETIRED JOB ONLY LEAVES SEARCH
// once its row drains. Jobs pruned at 19:50 were still being returned by /api/jobs an hour later
// with index_dirty_at PENDING, and one company showed postgres live=27 against meili returning
// 28. Pruning dead jobs is pointless if the removals queue behind crawler writes for an hour.
//
// 500 x 12 = 6,000/tick, roughly 360k/hour against the previous 120k. BATCH stays at 500 and
// BATCH_PAUSE_MS at 2000: the burst SHAPE is what OOM-killed the index, not the hourly total, so
// the fix is more spaced batches rather than bigger ones.
const BATCH = parseInt(process.env.MEILI_SYNC_BATCH || '500', 10);
const MAX_BATCHES = parseInt(process.env.MEILI_SYNC_MAX_BATCHES || '12', 10);

// Pause between batches inside one tick. Meilisearch coalesces tasks that arrive together into a
// single indexing operation, so firing batches back-to-back rebuilds the exact burst the limits
// above exist to prevent — a smaller BATCH alone would not have stopped the OOM. Spacing them
// lets one commit before the next lands.
const BATCH_PAUSE_MS = parseInt(process.env.MEILI_SYNC_BATCH_PAUSE_MS || '2000', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function syncMeili() {
  if (!meili.enabled) return { skipped: 'MEILI_HOST unset' };

  const h = await meili.health();
  if (!h.ok) {
    logger.warn({ reason: h.reason }, 'Meili sync skipped — index unhealthy');
    return { skipped: h.reason };
  }

  let indexed = 0, removed = 0, batches = 0;

  for (; batches < MAX_BATCHES; batches++) {
    const { rows } = await query(
      `SELECT j.id, j.external_id, j.title, j.department, j.location, j.workplace_type,
              j.employment_type, j.experience_level, j.visa_sponsorship, j.role_category,
              j.is_remote, j.remote_worldwide, j.ats, j.url,
              j.salary_min, j.salary_max, j.salary_currency, j.salary_interval,
              j.posted_at, j.first_seen_at, j.removed_at, j.company_id,
              j.index_dirty_at::text AS dirty_txt,
              c.company_name, c.domain, c.ats_slug, c.logo_url
         FROM jobs j
         LEFT JOIN companies c ON c.id = j.company_id
        WHERE j.index_dirty_at IS NOT NULL
        ORDER BY j.index_dirty_at
        LIMIT ${BATCH}`
    );
    if (!rows.length) break;

    const live = rows.filter((r) => !r.removed_at);
    const dead = rows.filter((r) => r.removed_at);

    if (live.length) await meili.addDocuments(live.map(meili.toDocument));
    if (dead.length) await meili.deleteDocuments(dead.map((r) => r.id));

    // Clear only rows nobody re-dirtied while we were shipping.
    //
    // The stamp is compared as TEXT, not as a timestamp. index_dirty_at is `timestamp without
    // time zone`; passing values back through the driver as timestamptz applies a timezone
    // conversion, so the comparison never matched — the loop re-shipped the same 20,000 rows
    // every minute for four hours while reporting success, and the queue never drained.
    // Round-tripping the exact text Postgres produced removes any conversion from the path.
    const ids = rows.map((r) => r.id);
    const maxStamp = rows.reduce((m, r) => (r.dirty_txt > m ? r.dirty_txt : m), rows[0].dirty_txt);
    const cleared = await query(
      `UPDATE jobs SET index_dirty_at = NULL
        WHERE id = ANY($1::int[])
          AND index_dirty_at::text <= $2`,
      [ids, maxStamp]
    );
    if (!cleared.rowCount) {
      logger.error({ batch: rows.length }, 'Meili sync cleared 0 rows — queue would loop; aborting');
      break;
    }

    indexed += live.length;
    removed += dead.length;
    if (rows.length < BATCH) break;
    if (BATCH_PAUSE_MS) await sleep(BATCH_PAUSE_MS);
  }

  // Companies whose indexed fields changed (logo, name, domain, slug) invalidate every one of
  // their job documents. Handled here rather than by marking those jobs in Postgres: the
  // largest company has ~39k live jobs and ~59k companies change per week, so marking would
  // be a bulk UPDATE. Re-pushing straight from the read side keeps the cost in this loop,
  // where it is already batched.
  const companies = await syncDirtyCompanies();

  if (indexed || removed || companies) {
    logger.info({ indexed, removed, batches, companies }, 'Meili sync complete');
  }
  return { indexed, removed, batches, companies };
}

const COMPANY_BATCH = parseInt(process.env.MEILI_COMPANY_BATCH || '20', 10);

async function syncDirtyCompanies() {
  const { rows: dirty } = await query(
    `SELECT id, index_dirty_at::text AS dirty_txt FROM companies
      WHERE index_dirty_at IS NOT NULL ORDER BY index_dirty_at LIMIT ${COMPANY_BATCH}`
  );
  if (!dirty.length) return 0;

  let done = 0;
  for (const co of dirty) {
    // Page through this company's jobs so one large employer cannot produce a huge request.
    let after = 0;
    for (;;) {
      const { rows } = await query(
        `SELECT j.id, j.external_id, j.title, j.department, j.location, j.workplace_type,
                j.employment_type, j.experience_level, j.visa_sponsorship, j.role_category,
                j.is_remote, j.remote_worldwide, j.ats, j.url,
                j.salary_min, j.salary_max, j.salary_currency, j.salary_interval,
                j.posted_at, j.first_seen_at, j.company_id,
                c.company_name, c.domain, c.ats_slug, c.logo_url
           FROM jobs j JOIN companies c ON c.id = j.company_id
          WHERE j.company_id = $1 AND j.removed_at IS NULL AND j.id > $2
          ORDER BY j.id LIMIT 1000`,
        [co.id, after]
      );
      if (!rows.length) break;
      await meili.addDocuments(rows.map(meili.toDocument));
      after = rows[rows.length - 1].id;
      if (rows.length < 1000) break;
    }
    // Clear only if nothing changed again meanwhile — text comparison for the same reason as
    // the jobs path: index_dirty_at is `timestamp without time zone` and a timestamptz
    // round-trip through the driver shifts it so the comparison never matches.
    await query(
      `UPDATE companies SET index_dirty_at = NULL
        WHERE id = $1 AND index_dirty_at::text <= $2`,
      [co.id, co.dirty_txt]
    );
    done++;
  }
  return done;
}

/** Remove documents for rows that were hard-deleted (worker.js stale-job cleanup). */
async function removeFromIndex(ids) {
  if (!meili.enabled || !ids || !ids.length) return null;
  return meili.deleteDocuments(ids);
}

module.exports = { syncMeili, removeFromIndex };
