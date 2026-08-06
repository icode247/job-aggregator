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

const BATCH = parseInt(process.env.MEILI_SYNC_BATCH || '1000', 10);
const MAX_BATCHES = parseInt(process.env.MEILI_SYNC_MAX_BATCHES || '20', 10);

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
