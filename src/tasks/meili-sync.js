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
              j.posted_at, j.first_seen_at, j.removed_at, j.company_id, j.index_dirty_at,
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

    // Clear only rows nobody touched while we were shipping. `IS NOT DISTINCT FROM` matters:
    // a plain = would never match if the value were NULL.
    const ids = rows.map((r) => r.id);
    const stamps = rows.map((r) => r.index_dirty_at);
    await query(
      `UPDATE jobs
          SET index_dirty_at = NULL
         FROM (SELECT unnest($1::int[]) AS id, unnest($2::timestamptz[]) AS stamp) u
        WHERE jobs.id = u.id
          AND jobs.index_dirty_at IS NOT DISTINCT FROM u.stamp`,
      [ids, stamps]
    );

    indexed += live.length;
    removed += dead.length;
    if (rows.length < BATCH) break;
  }

  if (indexed || removed) logger.info({ indexed, removed, batches }, 'Meili sync complete');
  return { indexed, removed, batches };
}

/** Remove documents for rows that were hard-deleted (worker.js stale-job cleanup). */
async function removeFromIndex(ids) {
  if (!meili.enabled || !ids || !ids.length) return null;
  return meili.deleteDocuments(ids);
}

module.exports = { syncMeili, removeFromIndex };
