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
const logger = require('../../logger');
const { isShortAlias } = require('../../utils/location-aliases');
const { resolveCountry } = require('../../utils/location-countries');
const { parsePostedWindow } = require('../../utils/posted-window');
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
      else if (['onsite', 'on-site', 'on_site'].includes(m)) {
        // Both spellings, because the index is NOT the clean copy this line once assumed.
        // toDocument copies workplace_type through untouched, so the deferred Postgres backfill
        // left `on_site` sitting next to `onsite` — 49,820 documents that a single equality
        // filter silently drops. Postgres matches both, so filtering on one under-counted by
        // exactly that population. Equality is case-insensitive, so casing is not the issue.
        or.push(`workplace_type = ${q('Onsite')}`);
        or.push(`workplace_type = ${q('on_site')}`);
      }
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
  // A country term does not go through CONTAINS at all. Short aliases can't: location-aliases.js
  // requires us/uk/uae to match as whole words, and CONTAINS "us" would return Houston. Instead
  // the term resolves to a country code and filters on location_countries, which meili.js
  // resolved at index time. The canonical name is OR'd in as a substring so a location that
  // names the country without a parseable code ("Work from United States") still matches, and
  // so an ambiguous term keeps its other meaning — "Georgia" finds both the country and Atlanta.
  const locs = toList(filters.location);
  if (locs.length) {
    const or = [];
    for (const l of locs) {
      const country = resolveCountry(l);
      if (country) {
        or.push(`location_countries = ${q(country.code)}`);
        continue; // indexed, ~47ms — no substring scan needed
      }
      // location_tokens is the tokenised location written at index time. Verified 2026-08-07 at
      // 100% coverage (2,758,541 of 2,758,541 docs) before this line was switched on — filtering
      // on an attribute the index does not carry makes Meilisearch reject the entire search,
      // which sends every city filter to Postgres and returns 500s.
      //
      // Measured: exact filter ~47ms vs `location CONTAINS` at 8,589ms standalone and 12,736ms
      // combined with the ats list the board sends on every search. CONTAINS is an unindexed
      // substring scan and was the last operator forcing this path back onto Postgres.
      const term = String(l).trim().toLowerCase();
      or.push(`location_tokens = ${q(term)}`);
      // A phrase longer than the tokeniser holds as one unit still needs the substring scan.
      if (term.split(/\s+/).length > 4) or.push(`location CONTAINS ${q(term)}`);
    }
    parts.push(`(${[...new Set(or)].join(' OR ')})`);
  }

  if (filters.posted) {
    // Same shared parser as the SQL path. This used to carry its own copy of the regex, so a
    // window it could not parse returned null and pushed the request onto Postgres — which then
    // could not parse it either, dropped the filter, and ran unfiltered until it timed out.
    const parsed = parsePostedWindow(filters.posted);
    if (!parsed) return null;
    parts.push(`posted_ts >= ${Math.floor(Date.now() / 1000) - parsed.seconds}`);
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
  if (!built) {
    // The other silent fallback: a filter set the index cannot express faithfully. Same cost as
    // the catch below — the request lands on the slow Postgres path — so it gets the same warning.
    logger.warn({ filters: summariseFilters(filters) },
      'Meili filter not expressible — falling back to Postgres (expect a slow query)');
    return null;
  }

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

    // Descriptions live in Postgres, not the index. meili.js leaves them out on purpose: they
    // are an order of magnitude larger than the title/company/location metadata, and indexing
    // 23GB of them would need a bigger disk and far more memory than the search itself does.
    //
    // So hydrate instead of falling back. This is the standard search-index shape — the index
    // answers "which jobs, in what order" and the database supplies the heavy column for just
    // the page being returned. It is a primary-key lookup on at most `limit` ids, nothing like
    // the full-table scans that made the SQL search path slow in the first place.
    //
    // Without this, /api/jobs?include=description came back with description: null on every row
    // while reporting servedBy: meili — a successful-looking response with the content missing.
    if (filters.includeDescription && rows.length) {
      const { query } = require('../connection');
      const { rows: descs } = await query(
        'SELECT id, description FROM jobs WHERE id = ANY($1::bigint[])',
        [rows.map((r) => r.id)]
      );
      const byId = new Map(descs.map((d) => [String(d.id), d.description]));
      for (const r of rows) r.description = byId.get(String(r.id)) ?? null;
    }

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
    // Never let an index problem break the board — but say so. Falling back is not free: the
    // Postgres equivalent of a narrow ATS filter measured 9s (18s with a date window) and blows
    // the statement timeout, so a silent `return null` here surfaces to users as "failed to
    // fetch" with nothing in the log to explain it. On 2026-08-10 that cost a full round of
    // diagnosis for 33 timeouts whose cause was invisible.
    logger.warn({ err: err.message, filters: summariseFilters(filters) },
      'Meili search failed — falling back to Postgres (expect a slow query)');
    return null;
  }
}

// Small, bounded description of a filter set for logs — never the raw object, which carries
// free-text search terms.
function summariseFilters(filters = {}) {
  return {
    keys: Object.keys(filters).sort().join(','),
    ats: Array.isArray(filters.ats) ? filters.ats.join('|').slice(0, 60) : undefined,
    posted: filters.posted ? String(filters.posted).slice(0, 24) : undefined,
  };
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
