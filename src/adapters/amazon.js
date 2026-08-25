/**
 * Amazon — www.amazon.jobs
 *
 * Public JSON search, no auth, no cookies, no JS:
 *   GET https://www.amazon.jobs/en/search.json?result_limit=100&offset=N&sort=recent
 *
 * The single best feed of the six: it returns the FULL description inline on the search
 * response, so unlike Netflix or Jobvite there is no per-job detail fetch and no description
 * backfill debt. 100 rows per request, descriptions included, ~25KB per 10 jobs.
 *
 * TWO HARD LIMITS, both measured 2026-08-25 rather than assumed:
 *
 *   result_limit > 100   -> {"error":"Result limit cannot be greater than 100"}
 *   offset >= 10000      -> {"error":"Cannot return more than 10000 results at once"}
 *
 * And `hits` is CLAMPED at 10000 — it reads 10000 for an unfiltered query, for
 * country[]=IRL, and for job_category[]=Solutions Architect alike, so it is not a total and
 * must never be used as one.
 *
 * FILTERS MOSTLY DO NOT WORK on this endpoint, which is the thing that shapes the whole design.
 * Probed side by side: `country[]=IRL` and `loc_query=Ireland` returned byte-identical first
 * pages to the unfiltered query (Gilroy CA, Seville, Alicante), so they are silently ignored.
 * Only `base_query` actually changes the result set — `base_query=software` returned Seattle,
 * Irvine and Bengaluru. So keyword is the ONLY usable shard dimension, which is the same
 * conclusion the Workable marketplace crawler reached, and it reuses the same role vocabulary
 * (scripts/job-roles.js) rather than inventing a second one.
 *
 * WHY THE DEFAULT SWEEP IS UNSHARDED. syncForCompany retires anything missing from an incoming
 * set, so a sweep must be self-consistent. One unfiltered `sort=recent` walk to the 10,000-row
 * ceiling is exactly that: a complete, coherent slice of the most recent postings. Union-ing
 * dozens of keyword shards is NOT — shard coverage shifts between runs, so jobs would flicker in
 * and out of the set and be retired and revived on alternating syncs. Keyword sharding is
 * therefore opt-in via KEYWORDS, for a deliberate deep sweep, and the returned meta reports
 * `capped` so the caller can tell a ceiling-limited sweep from a complete one.
 */
const { inferWorkplace, htmlToText, toIso, fetchJson, sleep } = require('./faang-common');
const logger = require('../logger');

const BASE = 'https://www.amazon.jobs/en/search.json';
const SITE = 'https://www.amazon.jobs';
const PAGE_SIZE = 100;      // hard API maximum
const MAX_OFFSET = 10000;   // hard API maximum
const PAGE_DELAY_MS = 300;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://www.amazon.jobs/en/search',
};

/**
 * Amazon posts under many legal entities — "Amazon Data Services, Inc.", "Amazon Web Services
 * EMEA SARL", "Audible, Inc.". company_name is kept in raw_data for provenance but is NOT used
 * as the company identity: every one of these rows belongs to the single Amazon board we synced,
 * and letting the entity name through would split one company into dozens on the board.
 */
function normalise(job) {
  const id = job.id_icims || job.id;
  if (!id) return null;

  // description_short is a teaser; the real body is description + qualifications, which is what
  // makes this feed worth having. Joined in the order a candidate reads them.
  const description = [
    htmlToText(job.description),
    job.basic_qualifications ? `Basic qualifications\n${htmlToText(job.basic_qualifications)}` : null,
    job.preferred_qualifications ? `Preferred qualifications\n${htmlToText(job.preferred_qualifications)}` : null,
  ].filter(Boolean).join('\n\n') || null;

  // normalized_location ("Gilroy, California, USA") is far more useful to the location filter
  // than location ("US, CA, Gilroy"), which puts the country first and no city parser expects.
  const location = job.normalized_location || job.location || null;

  return {
    external_id: `amazon_${id}`,
    title: (job.title || '').trim() || null,
    department: job.job_category || job.business_category || job.team || null,
    location,
    // Structured fields only — see inferWorkplace. Amazon's descriptions mention "virtual" and
    // "remote" constantly as product vocabulary (WorkSpaces, remote sensing) and even carry the
    // sentence "these are not remote positions", so reading them flags roughly half the board
    // remote and every one of those is wrong.
    workplace_type: inferWorkplace({ title: job.title, location }),
    employment_type: job.job_schedule_type || null,
    description,
    url: job.job_path ? `${SITE}${job.job_path}` : null,
    posted_at: toIso(job.posted_date),
    raw_data: {
      id_icims: job.id_icims,
      legal_entity: job.company_name || null,
      job_family: job.job_family || null,
      business_category: job.business_category || null,
      is_intern: job.is_intern,
      is_manager: job.is_manager,
      locations: job.locations || null,
      updated_time: job.updated_time || null,
      source_system: job.source_system || null,
    },
  };
}

async function fetchPage(offset, baseQuery) {
  const params = new URLSearchParams({
    result_limit: String(PAGE_SIZE),
    offset: String(offset),
    sort: 'recent',
  });
  if (baseQuery) params.set('base_query', baseQuery);
  const data = await fetchJson(`${BASE}?${params}`, { headers: HEADERS });
  if (data?.error) throw new Error(`Amazon API: ${data.error}`);
  return Array.isArray(data?.jobs) ? data.jobs : [];
}

/**
 * Walk one query to the offset ceiling, collecting into `seen`.
 * Returns true if it stopped because it HIT the ceiling (i.e. there was more we could not reach).
 */
async function sweep(baseQuery, seen, jobs) {
  for (let offset = 0; offset < MAX_OFFSET; offset += PAGE_SIZE) {
    const page = await fetchPage(offset, baseQuery);
    if (!page.length) return false; // ran out naturally — this query is fully covered

    for (const raw of page) {
      const job = normalise(raw);
      // Dedupe on external_id, not on array position: keyword shards overlap heavily (a
      // "Software Engineer" search and a "Backend Developer" search return many of the same
      // postings) and a duplicate external_id in one sync is an upsert conflict, not a new job.
      if (job && !seen.has(job.external_id)) {
        seen.add(job.external_id);
        jobs.push(job);
      }
    }
    if (page.length < PAGE_SIZE) return false;
    await sleep(PAGE_DELAY_MS);
  }
  return true; // stopped at MAX_OFFSET with more presumably behind it
}

/**
 * @param {string} slug  ignored for the default sweep; reserved so a future company row can pin
 *                       a shard without a code change.
 * @returns {{ jobs: Array, meta: { companyName: string, capped: boolean } }}
 */
async function fetchJobs(slug) {
  const jobs = [];
  const seen = new Set();
  let capped = false;

  // Opt-in deep sweep. Comma-separated keywords, or `1`/`all` for the shared role vocabulary.
  const kw = process.env.AMAZON_KEYWORDS;
  let queries = [null];
  if (kw) {
    if (kw === '1' || kw === 'all') {
      // Required lazily: scripts/job-roles.js is a 1,683-entry vocabulary that the default
      // unsharded path has no use for, and src/ should not pull from scripts/ on every boot.
      const { ALL_ROLES } = require('../../scripts/job-roles');
      queries = ALL_ROLES;
    } else {
      queries = kw.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }

  for (const q of queries) {
    try {
      if (await sweep(q, seen, jobs)) capped = true;
    } catch (err) {
      // One bad shard must not lose the shards already collected — but it DOES mean the sweep is
      // incomplete, so flag it as capped. Returning a short set unflagged is what would let
      // syncForCompany retire the jobs this shard would have covered.
      capped = true;
      logger.warn({ slug, query: q || '<unfiltered>', err: err.message }, 'Amazon: shard failed');
    }
  }

  if (capped) {
    logger.warn({ slug, jobs: jobs.length },
      'Amazon: sweep hit the 10,000-offset ceiling — set is a recent slice, not the full board');
  }
  return { jobs, meta: { companyName: 'Amazon', capped } };
}

module.exports = { fetchJobs, normalise };
