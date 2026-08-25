/**
 * Netflix — explore.jobs.netflix.net (Eightfold AI careers platform)
 *
 * Public JSON, no auth, no cookies, no JS:
 *   list   GET /api/apply/v2/jobs?domain=netflix.com&start=N&num=10
 *   detail GET /api/apply/v2/jobs/{id}?domain=netflix.com
 *
 * `num` IS CAPPED AT 10 and silently so — num=25 and num=50 both return exactly 10 rows
 * (measured 2026-08-25). Asking for more is not an error, it just quietly gives you ten, which
 * is the kind of cap that turns into "the board shrank" if you trust the request rather than the
 * response. Paging is therefore driven off `count` (506 at time of writing), not off the page
 * size we asked for.
 *
 * THE LIST RESPONSE CARRIES AN EMPTY `job_description`. Every position in the list has the field
 * present and blank, so it looks populated to a careless mapper and would store 506 jobs with no
 * description. The per-position detail endpoint has the real body (~9.5KB of HTML), so each job
 * costs one extra request. That is the whole reason this adapter has a detail phase at all.
 *
 * WHY NOT WORKDAY. companies already holds "Netflix Services Canada ULC" on ats=workday with 433
 * jobs, inactive. That is a regional legal entity's Workday tenant, not the main board — the real
 * Netflix careers site is this Eightfold instance. Both can coexist because they are separate
 * company rows with separate career_urls, but the Workday row is stale and should be retired
 * rather than synced alongside this one, or the same role appears twice on the board.
 */
const { inferWorkplace, htmlToText, toIso, mapLimit, fetchJson, sleep } = require('./faang-common');
const logger = require('../logger');

const API = 'https://explore.jobs.netflix.net/api/apply/v2/jobs';
const DOMAIN = 'netflix.com';
const PAGE_SIZE = 10;        // hard API cap — larger values are silently clamped
const DETAIL_CONCURRENCY = 6;
const PAGE_DELAY_MS = 200;
const MAX_PAGES = 400;       // 4,000 jobs; a runaway-loop backstop, not an expected limit

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://explore.jobs.netflix.net/careers',
};

async function fetchListPage(start) {
  const url = `${API}?domain=${DOMAIN}&start=${start}&num=${PAGE_SIZE}`;
  const data = await fetchJson(url, { headers: HEADERS });
  return { positions: Array.isArray(data?.positions) ? data.positions : [], count: Number(data?.count) || 0 };
}

async function fetchDetail(id) {
  try {
    return await fetchJson(`${API}/${encodeURIComponent(id)}?domain=${DOMAIN}`, { headers: HEADERS });
  } catch {
    return null; // a missing detail must not lose the listing row — see normalise
  }
}

function normalise(pos, detail) {
  const id = pos.id || detail?.id;
  if (!id) return null;
  const d = detail || {};

  // `location` is Eightfold's single display string ("USA - Remote"); `locations` is the full
  // array. The board stores one string, so the array goes to raw_data rather than being joined
  // into something no location filter can match.
  const locations = Array.isArray(d.locations) && d.locations.length ? d.locations
    : Array.isArray(pos.locations) && pos.locations.length ? pos.locations : [];
  const location = d.location || pos.location || locations[0] || null;

  // work_location_option / location_flexibility are Eightfold's OWN structured workplace fields.
  // Using them beats guessing from the title, and they are why this adapter does not need to
  // read the description for a workplace signal (which would be wrong anyway — see inferWorkplace).
  const workplaceField = [d.work_location_option, d.location_flexibility].filter(Boolean).join(' ');

  return {
    external_id: `netflix_${id}`,
    title: (d.name || pos.name || '').trim() || null,
    department: d.department || pos.department || d.business_unit || pos.business_unit || null,
    location,
    workplace_type: inferWorkplace({ title: d.name || pos.name, location, workplaceField }),
    employment_type: null, // Eightfold does not expose one on this endpoint
    description: htmlToText(d.job_description) || null,
    url: d.canonicalPositionUrl || pos.canonicalPositionUrl
      || `https://explore.jobs.netflix.net/careers/job/${id}`,
    // t_create is when the requisition opened; t_update moves on every edit. Posting date is the
    // former — using t_update would make an edited six-month-old req look posted today.
    posted_at: toIso(d.t_create || pos.t_create || d.t_update || pos.t_update),
    raw_data: {
      ats_job_id: d.ats_job_id || pos.ats_job_id || null,
      display_job_id: d.display_job_id || pos.display_job_id || null,
      business_unit: d.business_unit || pos.business_unit || null,
      locations,
      work_location_option: d.work_location_option || null,
      location_flexibility: d.location_flexibility || null,
      t_update: d.t_update || pos.t_update || null,
    },
  };
}

async function fetchJobs(slug) {
  // --- Phase 1: walk the listing, 10 at a time, until `count` is satisfied.
  const positions = [];
  const seen = new Set();
  let count = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const { positions: batch, count: total } = await fetchListPage(page * PAGE_SIZE);
    if (page === 0) count = total;
    if (!batch.length) break;
    for (const p of batch) {
      // Eightfold repeats a position across pages when the underlying set shifts mid-walk, and a
      // duplicate external_id inside one sync is an upsert conflict rather than a second job.
      if (p.id && !seen.has(p.id)) { seen.add(p.id); positions.push(p); }
    }
    if (count && positions.length >= count) break;
    if (batch.length < PAGE_SIZE) break;
    await sleep(PAGE_DELAY_MS);
  }

  if (!positions.length) return { jobs: [], meta: { companyName: 'Netflix', capped: false } };

  // --- Phase 2: one detail request per position — the only place a description exists.
  const details = await mapLimit(positions, DETAIL_CONCURRENCY, (p) => fetchDetail(p.id));

  const jobs = [];
  for (let i = 0; i < positions.length; i++) {
    const job = normalise(positions[i], details[i]);
    if (job) jobs.push(job);
  }

  // A detail fetch that failed yields a job with no description rather than no job at all —
  // dropping it would hand syncForCompany a short set and retire a live posting over a timeout.
  const missing = jobs.filter((j) => !j.description).length;
  if (missing) logger.warn({ slug, missing, total: jobs.length }, 'Netflix: postings without a description');

  // `capped` means "we know this set is short of the board". A listing walk that reached `count`
  // is complete even if some descriptions are missing, so this is only true when the walk itself
  // fell short.
  const capped = Boolean(count) && jobs.length < count;
  if (capped) logger.warn({ slug, got: jobs.length, count }, 'Netflix: listing walk returned fewer than count');

  return { jobs, meta: { companyName: 'Netflix', capped } };
}

module.exports = { fetchJobs, normalise };
