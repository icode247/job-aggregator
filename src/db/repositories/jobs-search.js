/**
 * Meilisearch-backed implementation of the job search read path.
 *
 * Mirrors jobsRepo.findActive / countActive so the route can swap between engines without
 * changing its response shape. Returns null when the index is unavailable or the filter set is
 * one it cannot serve faithfully, and the caller falls back to Postgres — a slower correct
 * answer always beats a fast wrong one.
 *
 * Why this exists: /api/facets, /api/roles and /api/trending each aggregate over 2.8M live rows
 * in Postgres. Even indexed they cost hundreds of ms; uncached and cold they hit 40-60s and blew
 * the statement timeout. Meilisearch returns those counts as a byproduct of the search it has
 * already run, and adds typo tolerance and relevance ranking Postgres full-text cannot.
 */
const meili = require('../../utils/meili');
const { aliasGroup, isShortAlias } = require('../../utils/location-aliases');
const { normalizeEmploymentType } = require('../../utils/extract');

const COUNT_CAP = parseInt(process.env.SEARCH_COUNT_CAP, 10) || 10000;

const toList = (v) => {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))];
};

/** Meilisearch filter strings need quotes escaped, since values are interpolated. */
const q = (v) => `"${String(v).replace(/["\\]/g, '\\$&')}"`;

/**
 * Build a Meilisearch filter expression from the board's filter object.
 * Returns null if any filter cannot be expressed faithfully — the caller then uses Postgres.
 */
function buildFilter(filters = {}) {
  const parts = [];

  const modes = toList(filters.workMode).map((m) => m.toLowerCase()).filter((m) => m !== 'any');
  if (modes.length) {
    const or = [];
    for (const m of modes) {
      if (m === 'remote') or.push('is_remote = true');
      else if (m === 'hybrid') or.push(`workplace_type = ${q('Hybrid')}`);
      else if (['onsite', 'on-site', 'on_site'].includes(m)) or.push(`workplace_type = ${q('Onsite')}`);
      // workplace_type is only partially normalised in Postgres (the backfill was deferred),
      // so legacy spellings still exist there. They are normalised on the way INTO the index by
      // toDocument's source row, meaning the index is the clean copy — no legacy variants here.
    }
    if (or.length) parts.push(`(${or.join(' OR ')})`);
  }

  const types = toList(filters.employmentType).filter((t) => t.toLowerCase() !== 'any')
    .map(normalizeEmploymentType).filter(Boolean);
  if (types.length) parts.push(`(${types.map((t) => `employment_type = ${q(t)}`).join(' OR ')})`);

  const levels = toList(filters.experienceLevel);
  if (levels.length) parts.push(`(${levels.map((l) => `experience_level = ${q(l)}`).join(' OR ')})`);

  const ats = toList(filters.ats);
  if (ats.length) parts.push(`(${ats.map((a) => `ats = ${q(a)}`).join(' OR ')})`);

  if (filters.companyId) parts.push(`company_id = ${parseInt(filters.companyId, 10)}`);
  if (filters.remote === 'true') parts.push('is_remote = true');
  if (filters.remoteWorldwide === 'true') parts.push('remote_worldwide = true');
  if (filters.visa) parts.push(`visa_sponsorship = ${q(filters.visa)}`);

  // Location: the SQL path does substring matching plus country-alias expansion.
  //
  // This used to fold the location terms into the free-text query instead, on the reasoning that
  // an equality filter would drop "Remote - United States" for someone searching "United States".
  // True, but it made location a ranking signal rather than a filter: `location=London` reported
  // 10,000+ matches where Postgres found 1,396, and results past the first page drifted to jobs
  // nowhere near London. An inflated count on the page is worse than a slower query.
  //
  // CONTAINS is the faithful equivalent of the SQL `ILIKE '%term%'` (it needs the containsFilter
  // experimental flag, enabled on the instance) and is case-insensitive, so terms go in lowered.
  //
  // Short aliases are the one case it cannot express. location-aliases.js requires us/uk/usa/uae
  // to match as whole words — CONTAINS "us" would hit Houston and Austin, and Meilisearch has no
  // word-boundary operator. Any query pulling in a short alias returns null so Postgres, which
  // does it with a word-boundary regex, answers instead.
  const locs = toList(filters.location);
  if (locs.length) {
    const terms = [];
    for (const l of locs) {
      for (const t of aliasGroup(l) ? [String(l).toLowerCase(), ...aliasGroup(l)] : [l]) {
        if (isShortAlias(t)) return null;
        terms.push(String(t).toLowerCase());
      }
    }
    const uniq = [...new Set(terms)];
    parts.push(`(${uniq.map((t) => `location CONTAINS ${q(t)}`).join(' OR ')})`);
  }

  if (filters.posted) {
    const m = String(filters.posted).trim().match(/^(\d+)\s*([hdwm])$/i);
    if (!m) return null; // unparseable window — let Postgres decide
    const n = parseInt(m[1], 10);
    const secs = { h: 3600, d: 86400, w: 604800, m: 2592000 }[m[2].toLowerCase()];
    if (!n || !secs) return null;
    parts.push(`posted_ts >= ${Math.floor(Date.now() / 1000) - n * secs}`);
  }

  return { filter: parts.length ? parts.join(' AND ') : undefined };
}

/** Build the free-text query. Roles are comma-separated; location is a filter, not a term. */
function buildQuery(filters) {
  const roles = filters.q ? String(filters.q).split(',').map((r) => r.trim()).filter(Boolean) : [];
  return roles.join(' ').trim();
}

/**
 * Search. Returns { rows, total, totalIsCapped } shaped like the Postgres path, or null to fall
 * back. Rows are index documents mapped back to the column names formatJob expects.
 */
async function search(filters = {}) {
  if (!meili.enabled) return null;

  const built = buildFilter(filters);
  if (!built) return null;

  const limit = Math.min(parseInt(filters.limit, 10) || 50, 200);
  const offset = parseInt(filters.offset, 10) || 0;

  try {
    const res = await meili.search({
      q: buildQuery(filters),
      filter: built.filter,
      limit,
      offset,
      // Freshness first, matching the board's existing ordering. With no search terms there is
      // nothing to rank by relevance, so sort is the only meaningful order.
      sort: ['first_seen_ts:desc'],
      facets: ['employment_type', 'experience_level', 'ats', 'workplace_type', 'role_category'],
    });
    if (!res) return null;

    const rows = (res.hits || []).map((h) => ({
      id: h.id,
      external_id: h.external_id,
      title: h.title,
      department: h.department,
      location: h.location,
      workplace_type: h.workplace_type,
      employment_type: h.employment_type,
      experience_level: h.experience_level,
      visa_sponsorship: h.visa_sponsorship,
      is_remote: h.is_remote,
      remote_worldwide: h.remote_worldwide,
      ats: h.ats,
      url: h.url,
      posted_at: h.posted_at,
      salary_min: h.salary_min,
      salary_max: h.salary_max,
      salary_currency: h.salary_currency,
      salary_interval: h.salary_interval,
      company_id: h.company_id,
      company_name: h.company_name,
      domain: h.company_domain,
      ats_slug: h.company_ats_slug,
      logo_url: h.company_logo_url,
    }));

    // estimatedTotalHits is bounded by the index's maxTotalHits (10000), matching the cap the
    // SQL path applies — so pagination behaves identically either way.
    const total = res.estimatedTotalHits ?? res.totalHits ?? rows.length;
    return {
      rows,
      total,
      totalIsCapped: total >= COUNT_CAP,
      facets: res.facetDistribution || null,
    };
  } catch (err) {
    // Never let an index problem break the board.
    return null;
  }
}

/** Facet counts with no query — replaces the four GROUP BY scans behind /api/facets. */
async function facets() {
  if (!meili.enabled) return null;
  try {
    const res = await meili.search({
      q: '',
      limit: 0,
      facets: ['employment_type', 'experience_level', 'ats', 'workplace_type', 'role_category'],
    });
    return (res && res.facetDistribution) || null;
  } catch {
    return null;
  }
}

module.exports = { search, facets, buildFilter, buildQuery, COUNT_CAP };
