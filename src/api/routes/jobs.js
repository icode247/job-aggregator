const { Router } = require('express');
const { jobsRepo } = require('../../db');
const { query, queryWithTimeout } = require('../../db/connection');
const { stripHtml } = require('../../utils/html');
const { recordSearchDemand, getTopDemand } = require('../searchDemand');

const router = Router();

function formatJob(row, includeDescription = false) {
  const job = {
    id: row.id,
    external_id: row.external_id,
    title: row.title,
    department: row.department,
    location: row.location,
    workplace_type: row.workplace_type,
    employment_type: row.employment_type,
    is_remote: row.is_remote || false,
    remote_worldwide: row.remote_worldwide || false,
    visa_sponsorship: row.visa_sponsorship || null,
    experience_level: row.experience_level || null,
    url: row.url,
    posted_at: row.posted_at,
    ats: row.ats,
    salary: {
      min: row.salary_min,
      max: row.salary_max,
      currency: row.salary_currency,
      interval: row.salary_interval,
    },
    company: {
      id: row.company_id,
      name: row.company_name,
      domain: row.domain,
      ats_slug: row.ats_slug,
      logo_url: row.logo_url,
    },
  };
  if (includeDescription) {
    job.description = row.description ? stripHtml(row.description) : null;
  }
  return job;
}

/**
 * GET /api/jobs
 *
 * Query params (★ = supports multiple comma-separated values, OR-semantics
 * within the field, AND-semantics across fields):
 *
 *   q ★              - Role / keywords (comma-separated for "role A, role B, role C")
 *   work_mode ★      - any | remote | hybrid | onsite       (e.g. "remote,hybrid")
 *   employment_type ★ - full-time | part-time | contract | internship | any
 *   location ★       - Free text (e.g. "United States,Canada,United Kingdom")
 *   experience_level ★ - internship | entry | mid | senior | lead | executive
 *   ats ★            - ATS platform (e.g. "ashby,greenhouse,breezy")
 *   posted           - Nh | Nd | Nw | Nm (e.g. 2h, 6h, 12h, 24h, 7d, 30d, 90d, 3m).
 *                      Filters on first_seen_at (listing freshness) — source posted_at is
 *                      date-only/null for ~half the jobs, so it can't do hour-level windows.
 *   remote           - true (only fully remote jobs, indexed)
 *   remote_worldwide - true (remote jobs open to any location globally)
 *   visa             - yes | no (H1B/visa sponsorship filter)
 *   company_id       - Filter by company ID (single)
 *   limit            - Results per page (default 50, max 200)
 *   page             - Page number (1-based, alternative to offset)
 *   offset           - Pagination offset
 *
 * Multi-value can also be passed via repeated keys: ?location=US&location=Canada
 * (Express qs parser handles this transparently and yields an array.)
 */
router.get('/api/jobs', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const pageParam = parseInt(req.query.page, 10);
  const offset = pageParam > 0 ? (pageParam - 1) * limit : (parseInt(req.query.offset, 10) || 0);

  const filters = { limit, offset };

  if (req.query.q) filters.q = req.query.q;
  if (req.query.work_mode) filters.workMode = req.query.work_mode;
  if (req.query.employment_type) filters.employmentType = req.query.employment_type;
  if (req.query.location) filters.location = req.query.location;
  // Canonical param is `posted`; accept `posted_after` and `datePosted` as aliases because
  // different deployed frontends send different names (Browse-and-apply v2 on `main` sends
  // `datePosted`, an older build sent `posted_after`). All take the same Nh/Nd/Nw/Nm value.
  if (req.query.posted || req.query.posted_after || req.query.datePosted)
    filters.posted = req.query.posted || req.query.posted_after || req.query.datePosted;
  if (req.query.remote) filters.remote = req.query.remote;
  if (req.query.remote_worldwide) filters.remoteWorldwide = req.query.remote_worldwide;
  if (req.query.visa) filters.visa = req.query.visa;
  if (req.query.experience_level) filters.experienceLevel = req.query.experience_level;
  if (req.query.company_id) filters.companyId = parseInt(req.query.company_id, 10);
  if (req.query.ats) filters.ats = req.query.ats.split(',');

  const includeDesc = req.query.include === 'description';
  if (includeDesc) filters.includeDescription = true;

  const [jobs, total] = await Promise.all([
    jobsRepo.findActive(filters),
    jobsRepo.countActive(filters),
  ]);

  // countActive stops at COUNT_CAP+1, so a value above the cap means "at least this many"
  // rather than an exact figure. Report the cap and say so, instead of implying precision we
  // did not pay for. Real paging never reaches 10,000 results (200 pages at 50/page).
  const { COUNT_CAP } = jobsRepo;
  const totalIsCapped = total > COUNT_CAP;
  const reportedTotal = totalIsCapped ? COUNT_CAP : total;

  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(reportedTotal / limit);
  const hasNext = offset + limit < reportedTotal;
  const hasPrev = offset > 0;

  res.json({
    meta: {
      total: reportedTotal,
      totalIsCapped,
      limit,
      offset,
      page,
      totalPages,
      hasNext,
      hasPrev,
      nextOffset: hasNext ? offset + limit : null,
      prevOffset: hasPrev ? Math.max(0, offset - limit) : null,
    },
    data: jobs.map(j => formatJob(j, includeDesc)),
  });

  // Fire-and-forget demand capture — NEVER awaited, self-contained try/catch, so it cannot
  // slow or break the response. Only the initial page (offset 0) counts as one user search,
  // so pagination doesn't inflate the count.
  if (offset === 0) recordSearchDemand(filters, total).catch(() => {});
});

/**
 * GET /api/demand
 * Top unmet search demand — most-searched, fewest-results first. Drives demand-based crawling.
 * Query: limit (default 100, max 500), max_results (only searches that returned <= N)
 */
router.get('/api/demand', async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  const maxResults = req.query.max_results != null ? parseInt(req.query.max_results, 10) : null;
  const rows = await getTopDemand({ limit, maxResults });
  res.json({ count: rows.length, data: rows });
});

/**
 * GET /api/stats
 * Global stats for landing pages and SEO
 */
// Cached for the same reason as /api/facets below. By total execution time this was the
// second heaviest query on the database — 240,361s across 18,979 calls — because every one
// of those counts scans the whole live set. The numbers are headline figures on a landing
// page; a few minutes stale is invisible, and it was 64s cold.
let statsCache = null;
let statsCacheExpiry = 0;
let statsInFlight = null;
const STATS_TTL_MS = 5 * 60 * 1000;

router.get('/api/stats', async (req, res) => {
  if (statsCache && Date.now() < statsCacheExpiry) return res.json({ data: statsCache });
  if (statsInFlight && statsCache) return res.json({ data: statsCache });
  try {
    statsInFlight = statsInFlight || query(
      `SELECT
        COUNT(*) as total_jobs,
        COUNT(*) FILTER (WHERE is_remote = true) as remote_jobs,
        COUNT(*) FILTER (WHERE visa_sponsorship = 'yes') as visa_sponsorship_jobs,
        COUNT(DISTINCT company_id) as companies,
        COUNT(DISTINCT ats) as platforms
      FROM jobs WHERE removed_at IS NULL`
    ).then((r) => r.rows[0]);
    const data = await statsInFlight;
    statsCache = data;
    statsCacheExpiry = Date.now() + STATS_TTL_MS;
    res.json({ data });
  } catch (err) {
    if (statsCache) return res.json({ data: statsCache }); // stale beats an error page
    throw err;
  } finally {
    statsInFlight = null;
  }
});

/**
 * GET /api/trending
 * Trending job searches and categories
 * Returns trending roles, locations, companies, and search terms
 * Cached for 1 hour
 */
let trendingCache = null;
let trendingCacheExpiry = 0;

// Single in-flight slot. This endpoint fires ~6 full-table aggregates per request and the
// cache only fills once they succeed, so without this each concurrent visitor launched
// another 6. Under real traffic that consumed every connection in the pool — 14 of 14 active
// on these queries — and starved even the cached endpoints, which then failed too.
let trendingInFlight = null;

router.get('/api/trending', async (req, res) => {
  if (trendingCache && Date.now() < trendingCacheExpiry) {
    return res.json(trendingCache);
  }
  // A refresh is already running: serve the previous value rather than piling on. With no
  // previous value there is nothing to serve, so wait for the one in flight instead of
  // starting a competing copy.
  if (trendingInFlight) {
    if (trendingCache) return res.json(trendingCache);
    try { return res.json(await trendingInFlight); } catch { return res.status(503).json({ error: 'warming' }); }
  }

  trendingInFlight = (async () => {
  const [
    { rows: recentRoles },
    { rows: hotLocations },
    { rows: topCompanies },
    { rows: remoteStats },
    { rows: visaStats },
    { rows: newToday },
  ] = await Promise.all([
    // Trending roles — most posted in last 24 hours
    queryWithTimeout(
      // Stored column, not a ~25-branch CASE over every job in the window. COALESCE covers
      // rows the backfill has not reached yet; excluding 'Other' keeps the list meaningful.
      `SELECT role_category AS role, COUNT(*) as job_count
         FROM jobs
        WHERE removed_at IS NULL
          AND first_seen_at > NOW() - INTERVAL '24 hours'
          AND role_category IS NOT NULL AND role_category <> 'Other'
        GROUP BY role_category ORDER BY job_count DESC LIMIT 15`
    ),
    // Hot locations — most new jobs in last 24 hours
    queryWithTimeout(
      `SELECT location, COUNT(*) as job_count
      FROM jobs
      WHERE removed_at IS NULL AND location IS NOT NULL
        AND first_seen_at > NOW() - INTERVAL '24 hours'
      GROUP BY location
      ORDER BY job_count DESC
      LIMIT 20`
    ),
    // Top hiring companies — most new jobs in last 24 hours
    queryWithTimeout(
      `SELECT c.company_name as name, c.domain, c.logo_url, COUNT(j.id) as job_count
      FROM companies c JOIN jobs j ON j.company_id = c.id
      WHERE j.removed_at IS NULL AND j.first_seen_at > NOW() - INTERVAL '24 hours'
        AND c.company_name IS NOT NULL
      GROUP BY c.id, c.company_name, c.domain, c.logo_url
      ORDER BY job_count DESC
      LIMIT 20`
    ),
    // Remote job trends
    queryWithTimeout(
      `SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE first_seen_at > NOW() - INTERVAL '7 days') as new_this_week,
        COUNT(*) FILTER (WHERE first_seen_at > NOW() - INTERVAL '1 day') as new_today
      FROM jobs WHERE removed_at IS NULL AND is_remote = true`
    ),
    // Visa sponsorship trends
    queryWithTimeout(
      `SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE first_seen_at > NOW() - INTERVAL '7 days') as new_this_week,
        COUNT(*) FILTER (WHERE first_seen_at > NOW() - INTERVAL '1 day') as new_today
      FROM jobs WHERE removed_at IS NULL AND visa_sponsorship = 'yes'`
    ),
    // New jobs today count
    queryWithTimeout(
      `SELECT COUNT(*) as count
      FROM jobs WHERE removed_at IS NULL AND first_seen_at > NOW() - INTERVAL '1 day'`
    ),
  ]);

  const result = {
    data: {
      trending_roles: recentRoles,
      hot_locations: hotLocations,
      top_hiring_companies: topCompanies,
      remote_jobs: remoteStats[0],
      visa_sponsorship_jobs: visaStats[0],
      new_jobs_today: parseInt(newToday[0].count, 10),
    },
  };

  trendingCache = result;
  trendingCacheExpiry = Date.now() + 60 * 60 * 1000; // 1 hour
  return result;
  })();

  try {
    res.json(await trendingInFlight);
  } catch (err) {
    if (trendingCache) return res.json(trendingCache); // stale beats an error page
    throw err;
  } finally {
    trendingInFlight = null;
  }
});

/**
 * GET /api/companies
 * Company directory with job counts
 * Query params: q, ats, limit, page
 */
router.get('/api/companies', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const page = parseInt(req.query.page, 10) || 1;
  const offset = (page - 1) * limit;

  const clauses = ['j.removed_at IS NULL'];
  const params = [];

  if (req.query.q) {
    clauses.push('c.company_name ILIKE ?');
    params.push(`%${req.query.q}%`);
  }
  if (req.query.ats) {
    clauses.push('c.ats = ?');
    params.push(req.query.ats);
  }

  const where = clauses.join(' AND ');

  const [{ rows }, { rows: countRows }] = await Promise.all([
    query(
      `SELECT c.id, c.company_name as name, c.domain, c.logo_url, c.ats,
        COUNT(j.id) as job_count,
        COUNT(j.id) FILTER (WHERE j.is_remote = true) as remote_job_count,
        COUNT(j.id) FILTER (WHERE j.visa_sponsorship = 'yes') as visa_job_count
      FROM companies c JOIN jobs j ON j.company_id = c.id
      WHERE ${where}
      GROUP BY c.id, c.company_name, c.domain, c.logo_url, c.ats
      ORDER BY job_count DESC
      LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    ),
    query(
      `SELECT COUNT(DISTINCT c.id) as count
      FROM companies c JOIN jobs j ON j.company_id = c.id
      WHERE ${where}`,
      params
    ),
  ]);

  const total = parseInt(countRows[0].count, 10);
  res.json({
    meta: { total, limit, page, totalPages: Math.ceil(total / limit) },
    data: rows.map(r => ({
      id: r.id,
      name: r.name || r.company_name,
      domain: r.domain,
      logo_url: r.logo_url,
      ats: r.ats,
      job_count: r.job_count,
      remote_job_count: r.remote_job_count,
      visa_job_count: r.visa_job_count,
    })),
  });
});

/**
 * GET /api/companies/:id
 * Single company profile with stats
 */
router.get('/api/companies/:id', async (req, res) => {
  const { rows } = await query(
    `SELECT c.id, c.company_name, c.domain, c.logo_url, c.ats, c.career_url,
      COUNT(j.id) as job_count,
      COUNT(j.id) FILTER (WHERE j.is_remote = true) as remote_job_count,
      COUNT(j.id) FILTER (WHERE j.visa_sponsorship = 'yes') as visa_job_count
    FROM companies c LEFT JOIN jobs j ON j.company_id = c.id AND j.removed_at IS NULL
    WHERE c.id = ?
    GROUP BY c.id`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Company not found' });
  res.json({ data: rows[0] });
});

/**
 * GET /api/locations
 * Top locations with job counts for location pages
 * Query params: q, limit
 */
router.get('/api/locations', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const params = [];
  let where = 'removed_at IS NULL AND location IS NOT NULL';

  if (req.query.q) {
    where += ' AND location ILIKE ?';
    params.push(`%${req.query.q}%`);
  }

  const { rows } = await query(
    `SELECT location, COUNT(*) as job_count
    FROM jobs WHERE ${where}
    GROUP BY location ORDER BY job_count DESC
    LIMIT ?`,
    [...params, limit]
  );
  res.json({ data: rows });
});

/**
 * GET /api/roles
 * Top role categories with job counts for role pages
 * Cached for 1 hour since it scans all jobs
 */
let rolesCache = null;
let rolesCacheExpiry = 0;

let rolesInFlight = null;

// Refreshing OFF the request path.
//
// This aggregate takes ~40s: it applies two dozen ILIKE patterns to every live job because
// the role category is derived at query time rather than stored. Heroku's router abandons a
// request at 30s, so whichever user triggered the refresh always got a 503 even though the
// query itself would finish — the cache filled, but only after somebody ate an error.
//
// Running it at boot and on a timer means the cache is always warm before anyone asks. The
// real fix is a stored role_category column so this stops being a full scan; until then this
// keeps the endpoint working without a user ever waiting on it.
function refreshRoles() {
  if (rolesInFlight) return rolesInFlight;
  rolesInFlight = (async () => {
  // Reads the stored role_category column instead of deriving the category with ~25 ILIKE
  // patterns over every live job. That derivation was a ~40s sequential scan; two copies of it
  // running at once starved the pool and returned 500s on /api/stats and /api/jobs even with
  // nothing else on the database.
  //
  // COALESCE covers rows the backfill has not reached yet — it is running in the low-traffic
  // window only, so this stays correct while the column fills in, and gets cheaper as it does.
  // jobsRepo already writes role_category for every new row.
  const { rows } = await queryWithTimeout(
    `SELECT
      COALESCE(role_category, 'Other') AS role,
      COUNT(*) as job_count,
      COUNT(*) FILTER (WHERE is_remote = true) as remote_count,
      COUNT(*) FILTER (WHERE visa_sponsorship = 'yes') as visa_count
    FROM jobs WHERE removed_at IS NULL
    GROUP BY role ORDER BY job_count DESC`
  );
  rolesCache = rows;
  rolesCacheExpiry = Date.now() + 60 * 60 * 1000; // 1 hour
  return rows;
  })().finally(() => { rolesInFlight = null; });
  return rolesInFlight;
}

router.get('/api/roles', async (req, res) => {
  if (rolesCache) return res.json({ data: rolesCache, stale: Date.now() >= rolesCacheExpiry });
  // Cold start only: nothing cached yet. Kick the refresh off and say so rather than holding
  // the request open for 40s to be killed by the router at 30s.
  refreshRoles().catch(() => {});
  return res.status(503).json({ error: 'warming', retry_after: 60 });
});

/**
 * GET /api/facets
 * Aggregated counts for filter sidebar (employment types, experience levels, ATS platforms)
 */
// Cached like the roles endpoint above. Even index-only, these four aggregates scan every
// live job: ~2.8s for the endpoint when run together, and it was being called ~18k times per
// query. The counts move slowly (a sync shifts them by a fraction of a percent), so serving a
// few-minute-old sidebar is indistinguishable to a user and removes the load entirely.
// A single stale-while-revalidate slot also stops a burst of concurrent requests all firing
// the same scan — the first caller refreshes, the rest are served the previous value.
let facetsCache = null;
let facetsCacheExpiry = 0;
let facetsInFlight = null;
const FACETS_TTL_MS = 5 * 60 * 1000;

async function loadFacets() {
  const [empTypes, expLevels, atsPlatforms, workModes] = await Promise.all([
    query(`SELECT employment_type, COUNT(*) as count FROM jobs
      WHERE removed_at IS NULL AND employment_type IS NOT NULL
      GROUP BY employment_type ORDER BY count DESC`),
    query(`SELECT experience_level, COUNT(*) as count FROM jobs
      WHERE removed_at IS NULL AND experience_level IS NOT NULL
      GROUP BY experience_level ORDER BY count DESC`),
    query(`SELECT ats, COUNT(*) as count FROM jobs
      WHERE removed_at IS NULL
      GROUP BY ats ORDER BY count DESC`),
    query(`SELECT workplace_type, COUNT(*) as count FROM jobs
      WHERE removed_at IS NULL AND workplace_type IS NOT NULL
      GROUP BY workplace_type ORDER BY count DESC`),
  ]);
  return {
    employment_types: empTypes.rows,
    experience_levels: expLevels.rows,
    ats_platforms: atsPlatforms.rows,
    work_modes: workModes.rows,
  };
}

router.get('/api/facets', async (req, res) => {
  if (facetsCache && Date.now() < facetsCacheExpiry) {
    return res.json({ data: facetsCache });
  }
  // Serve the stale value while a refresh is already running, rather than piling on.
  if (facetsInFlight && facetsCache) return res.json({ data: facetsCache });
  try {
    facetsInFlight = facetsInFlight || loadFacets();
    const data = await facetsInFlight;
    facetsCache = data;
    facetsCacheExpiry = Date.now() + FACETS_TTL_MS;
    res.json({ data });
  } catch (err) {
    if (facetsCache) return res.json({ data: facetsCache }); // stale beats an error page
    throw err;
  } finally {
    facetsInFlight = null;
  }
});

router.get('/api/jobs/:id', async (req, res) => {
  const job = await jobsRepo.findById(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const formatted = formatJob(job, true);
  formatted.description_html = job.description;
  res.json({ data: formatted });
});

module.exports = router;

// Boot-time priming and the refresh timer are DISABLED.
//
// The intent was that no user request would pay for this aggregate. In practice it fired the
// ~40s scan on a schedule regardless of whether anyone wanted it, and the in-flight guard did
// not hold — two copies were observed running concurrently at 25s each, starving the pool so
// that /api/stats and /api/jobs returned 500s with nothing else touching the database.
//
// The endpoint still self-serves: the first caller triggers refreshRoles() and gets a 503 with
// retry_after while it warms. That is a worse cold start for one caller, and a far better
// outcome than the whole site degrading on a timer. Re-enable once role_category is fully
// backfilled and indexed, when the query is an indexed GROUP BY rather than a full scan.
