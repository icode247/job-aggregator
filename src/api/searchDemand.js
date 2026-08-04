/**
 * Search-demand capture (Phase 0 of demand-driven crawling).
 *
 * Every user search that reaches GET /api/jobs is recorded + aggregated into search_demand,
 * along with how many results it returned. The signal we care about is "searched a lot,
 * returned little" — that's an unsatisfied customer, and the top of the crawlers' to-do list.
 *
 * SAFETY: recordSearchDemand is FIRE-AND-FORGET. Callers must never await it in the request
 * path. Everything is wrapped so it can never throw into, slow, or break the API response.
 * Kill instantly without a redeploy via env DEMAND_CAPTURE=0.
 */
const { query } = require('../db/connection');
const logger = require('../logger');

const ENABLED = process.env.DEMAND_CAPTURE !== '0';

// Normalize a field for stable dedup: coerce arrays, trim, collapse whitespace, lowercase, cap.
function norm(v) {
  if (v == null) return null;
  const s = String(Array.isArray(v) ? v.join(',') : v).trim().replace(/\s+/g, ' ').toLowerCase();
  return s ? s.slice(0, 200) : null;
}

/**
 * Record one search as demand. Best-effort; resolves regardless of DB outcome.
 * @param {object} filters - the parsed /api/jobs filters (q, location, employmentType, ...)
 * @param {number} resultCount - total matches that search returned (the key signal)
 */
async function recordSearchDemand(filters, resultCount) {
  try {
    if (!ENABLED || !filters) return;
    const q = norm(filters.q);
    const location = norm(filters.location);
    const employment = norm(filters.employmentType);
    const experience = norm(filters.experienceLevel);
    const workMode = norm(filters.workMode) || (String(filters.remote) === 'true' ? 'remote' : null);
    // Only record searches that express intent (a keyword or a filter) — skip pure browse.
    if (!q && !location && !employment && !experience && !workMode) return;
    const key = [q, location, employment, experience, workMode].map((x) => x || '').join('|');
    const rc = Number.isFinite(resultCount) ? resultCount : null;
    await query(
      `INSERT INTO search_demand
         (demand_key, query_text, location, employment_type, experience_level, work_mode,
          search_count, last_result_count, min_result_count, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (demand_key) DO UPDATE SET
         search_count      = search_demand.search_count + 1,
         last_result_count = EXCLUDED.last_result_count,
         min_result_count  = LEAST(COALESCE(search_demand.min_result_count, EXCLUDED.min_result_count), EXCLUDED.min_result_count),
         last_seen_at      = CURRENT_TIMESTAMP`,
      [key, q, location, employment, experience, workMode, rc, rc],
    );
  } catch (err) {
    logger.warn({ err: err.message }, 'search demand capture failed (ignored)');
  }
}

/**
 * Top unmet demand: most-searched, fewest-results first — the crawlers' priority list.
 * @param {object} opts - { limit, maxResults } (maxResults: only searches returning <= N)
 */
async function getTopDemand({ limit = 100, maxResults = null } = {}) {
  const params = [];
  let where = '';
  if (maxResults != null && Number.isFinite(maxResults)) {
    where = 'WHERE COALESCE(last_result_count, 0) <= ?';
    params.push(maxResults);
  }
  params.push(Math.min(limit, 500));
  const { rows } = await query(
    `SELECT query_text, location, employment_type, experience_level, work_mode,
            search_count, last_result_count, min_result_count, first_seen_at, last_seen_at
       FROM search_demand ${where}
      ORDER BY search_count DESC, last_result_count ASC
      LIMIT ?`,
    params,
  );
  return rows;
}

module.exports = { recordSearchDemand, getTopDemand };
