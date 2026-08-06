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

  // NOTE ON limit: this candidate query is a sequential scan over the whole live set (measured
  // cost ~694k — `id % N` is not sargable and the OR spans jobs and companies, so no index
  // covers it). The worker's pool allows 60s. At limit 3000 the query exceeded even that and
  // the loop pruned nothing at all, logging one line that looks identical to an idle cycle.
  //
  // Raising the timeout is the wrong lever: the worker runs PG_POOL_MAX=2, so holding a
  // dedicated client for 90s would leave one connection for every other loop in the process.
  // Keep the batch to what fits in 60s until the query itself is index-driven; then the limit
  // can go back up.
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
      ORDER BY missing_from_sync DESC, j.last_checked_at ASC NULLS FIRST
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
  const writeInChunks = async (sql, ids) => {
    for (let i = 0; i < ids.length; i += 500) {
      await query(sql, [ids.slice(i, i + 500)]);
      if (i + 500 < ids.length) await new Promise((r) => setTimeout(r, 250));
    }
  };

  if (deadIds.length) {
    await writeInChunks('UPDATE jobs SET removed_at = NOW() WHERE id = ANY($1::bigint[])', deadIds);
  }
  // Stamp every checked job so the rotation advances (including the ones we pruned).
  await writeInChunks('UPDATE jobs SET last_checked_at = NOW() WHERE id = ANY($1::bigint[])', jobs.map((j) => j.id));

  return { checked: jobs.length, dead: deadIds.length, uncertain };
}

module.exports = { DEAD_INDICATORS, checkUrl, runWithConcurrency, pruneDeadJobs };
