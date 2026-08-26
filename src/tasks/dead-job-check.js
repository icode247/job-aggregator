/**
 * Dead-job detection + pruning.
 *
 * Fetches a job's career-page URL and decides whether the posting is still live.
 * Used by:
 *   - the worker's runDeadJobPruning loop (src/worker.js), and
 *   - the scripts/check-dead-jobs.js CLI.
 *
 * Only *confirmed* dead postings (404/410 or an explicit dead-page phrase) are
 * pruned. Anything uncertain (timeout, 5xx, transient network error) is left
 * alone and simply re-checked on a later rotation.
 */

const DEAD_INDICATORS = [
  'this job posting is no longer available',
  'this position has been filled',
  'this job is no longer available',
  'this posting has expired',
  'job not found',
  'page not found',
  'position is no longer available',
  'this requisition is no longer available',
  'opportunity is no longer available',
  'this job has been closed',
  'job has expired',
  'no longer accepting applications',
  'this role has been filled',
  'listing has been removed',
  'sorry, this job is no longer open',
  'this position is closed',
  'the job you are looking for is no longer available',
  'this job listing has expired',
];

// Last meaningful path segment of a job URL — the posting's own identifier. Query strings and
// trailing slashes are ignored. Used to tell a redirect that keeps the posting from one that
// drops it (see checkUrl).
function lastPathSegment(u) {
  try {
    const parts = new URL(u).pathname.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
  } catch { return null; }
}

// Returns { alive: true|false|null, reason }. null = uncertain (do NOT prune).
async function checkUrl(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobChecker/1.0)' },
    });
    clearTimeout(timeout);

    if (res.status === 404 || res.status === 410) return { alive: false, reason: `HTTP ${res.status}` };
    if (!res.ok) return { alive: null, reason: `HTTP ${res.status}` };

    // Redirected off the posting entirely — the board root, or a listing index. Several ATS
    // platforms retire a job this way instead of 404ing: Breezy sends /p/{id}-{slug} to / with a
    // 200 and no dead-page phrase, so every check here said "alive" for a posting that is gone.
    // Found via a job a user reported by hand (church-of-the-highlands, id 229085207); the tell
    // is that the final URL no longer contains the posting's own identifier.
    //
    // Only fires when the original URL HAS an identifiable last segment and the destination has
    // dropped it. A canonicalising redirect that keeps the id is untouched, and a redirect to a
    // deeper path still containing the id stays alive.
    const finalUrl = res.url || url;
    if (finalUrl !== url) {
      const idSeg = lastPathSegment(url);
      if (idSeg && idSeg.length >= 6 && !finalUrl.toLowerCase().includes(idSeg.toLowerCase())) {
        return { alive: false, reason: `redirected off posting -> ${finalUrl.slice(0, 80)}` };
      }
    }

    const html = (await res.text()).toLowerCase();
    for (const indicator of DEAD_INDICATORS) {
      if (html.includes(indicator)) return { alive: false, reason: indicator };
    }
    if (html.length < 500 && (html.includes('sorry') || html.includes('error') || html.includes('not found'))) {
      return { alive: false, reason: `Short error page (${html.length} chars)` };
    }
    return { alive: true, reason: null };
  } catch (err) {
    if (err.name === 'AbortError') return { alive: null, reason: 'Timeout (15s)' };
    return { alive: null, reason: err.message };
  }
}

async function runWithConcurrency(items, maxConcurrency, fn) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxConcurrency, items.length) }, () => worker()));
  return results;
}

/**
 * Verify a rotating batch of jobs and prune confirmed-dead postings. This is now
 * the ONLY place jobs get marked removed_at — syncForCompany() (jobs.js) used to
 * also remove jobs via list-diff (any stored external_id missing from a sync's
 * incoming set), guarded by a >50%-missing skip heuristic. That was retired: the
 * heuristic froze real closures (ashby's jerry.ai: 350->48 jobs, frozen because
 * 97% were "missing"), and list-diffing itself proved unreliable — external_id
 * churn (a job reposted under a new id while still live at the same URL) showed
 * up independently on Greenhouse and Workday, where a blind diff would have
 * deleted hundreds of still-open jobs. HTTP verification doesn't have that
 * failure mode: a job is only ever removed on a confirmed 404/410 or an explicit
 * dead-page phrase.
 *
 * Scope is now the union of two populations, both eligible once `recheckDays`
 * has passed since their last check:
 *   1. The original tail — jobs posted more than `tailDays` ago (recent jobs are
 *      kept fresh by the crawler, so we don't waste fetches on them).
 *   2. Jobs "missing from the latest sync" — j.last_seen_at predates their
 *      company's last_synced_at by more than a few minutes, meaning the most
 *      recent successful sync didn't include them. This is the population that
 *      needs verifying now that nothing removes them at sync time. Prioritized
 *      first since it's fresh, actionable signal rather than background hygiene.
 *
 * `partitionMod`/`partitionRemainder` split the eligible population by
 * `j.id % partitionMod = partitionRemainder`, so multiple independent runners
 * (e.g. the Render worker and a local process) can each own a disjoint slice
 * with zero coordination and no risk of double-checking the same job — useful
 * for spreading outbound verification traffic across separate IPs/networks.
 * Defaults to no partitioning (mod=1, remainder=0 matches everything).
 *
 * @returns {Promise<{checked:number, dead:number, uncertain:number}>}
 */
async function pruneDeadJobs({
  limit = 400, concurrency = 10, tailDays = 30, recheckDays = 14,
  partitionMod = 1, partitionRemainder = 0,
} = {}) {
  const { query } = require('../db/connection');
  const t = Number(tailDays) || 30;
  const r = Number(recheckDays) || 14;
  const pMod = Number(partitionMod) || 1;
  const pRem = ((Number(partitionRemainder) || 0) % pMod + pMod) % pMod;

  // NO ORDER BY, deliberately. It used to sort by `missing_from_sync DESC, last_checked_at ASC`
  // to work the freshest signal first. That ordering cost everything: it cannot be served by an
  // index (missing_from_sync is computed across the join), so Postgres had to scan AND SORT the
  // entire eligible population — ~1.35M rows per partition — before returning a single row. The
  // LIMIT bought nothing, which is why shrinking the batch never helped.
  //
  // Measured against the live database:
  //     LIMIT    500 with ORDER BY  -> connection died
  //     LIMIT  1,000 with ORDER BY  -> exceeded the worker's 60s ceiling, pruned nothing
  //     LIMIT    500 without        ->  3.4s
  //     LIMIT 20,000 without        -> 33s
  //
  // Unordered, the scan stops as soon as it has LIMIT rows, so cost tracks the batch instead of
  // the backlog. Coverage does not depend on the ordering: every job in a batch gets stamped
  // with last_checked_at, which drops it out of the eligible set for recheckDays, so the queue
  // drains whatever order it is read in. Prioritisation was a nicety; completing was not.
  const { rows: jobs } = await query(
    `SELECT j.id, j.url,
            (c.last_synced_at IS NOT NULL AND j.last_seen_at < c.last_synced_at - INTERVAL '5 minutes') AS missing_from_sync
       FROM jobs j
       JOIN companies c ON c.id = j.company_id
      WHERE j.removed_at IS NULL
        AND j.url IS NOT NULL
        AND j.id % ${pMod} = ${pRem}
        AND (j.last_checked_at IS NULL OR j.last_checked_at < NOW() - INTERVAL '${r} days')
        AND (
          (j.posted_at IS NOT NULL AND j.posted_at < NOW() - INTERVAL '${t} days')
          OR (c.last_synced_at IS NOT NULL AND j.last_seen_at < c.last_synced_at - INTERVAL '5 minutes')
        )
      LIMIT $1`,
    [limit]
  );
  if (!jobs.length) return { checked: 0, dead: 0, uncertain: 0 };

  const deadIds = [];
  let uncertain = 0;
  await runWithConcurrency(jobs, concurrency, async (job) => {
    const result = await checkUrl(job.url);
    if (result.alive === false) deadIds.push(job.id);
    else if (result.alive === null) uncertain++;
  });

  // Write back in chunks with a breath between them. Both columns are indexed, so a single
  // 3000-row UPDATE is a real write on a 28GB table with 26 indexes — the shape that has
  // starved the API before. 500 at a time keeps each statement well inside the pool timeout
  // and leaves gaps for user queries.
  // SORTED, and each chunk locks in id order. Splitting one UPDATE into several introduced
  // `deadlock detected`: eleven crawlers upsert into this table continuously, and two
  // transactions touching the same rows in opposite orders deadlock by definition. Postgres
  // takes row locks in the order rows are visited, so every writer ascending by id can only
  // ever wait — never form a cycle. `ORDER BY id` inside the subquery is what enforces that;
  // `id = ANY(array)` alone does not guarantee visit order.
  const writeInChunks = async (sql, ids) => {
    const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 0; i < sorted.length; i += 500) {
      await query(sql, [sorted.slice(i, i + 500)]);
      if (i + 500 < sorted.length) await new Promise((r) => setTimeout(r, 250));
    }
  };

  if (deadIds.length) {
    await writeInChunks(
      `UPDATE jobs SET removed_at = NOW() WHERE id IN (
         SELECT id FROM jobs WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE
       )`, deadIds);
  }
  // Stamp every checked job so the rotation advances (including the ones we pruned).
  await writeInChunks(
    `UPDATE jobs SET last_checked_at = NOW() WHERE id IN (
       SELECT id FROM jobs WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE
     )`, jobs.map((j) => j.id));

  return { checked: jobs.length, dead: deadIds.length, uncertain };
}

module.exports = { DEAD_INDICATORS, checkUrl, runWithConcurrency, pruneDeadJobs };
