#!/usr/bin/env node
/**
 * Discover Jobvite career-site slugs.
 *
 * Jobvite publishes no index of its customers: jobs.jobvite.com has no robots.txt and its
 * sitemap.xml 302s away, our own companies table contains not a single jobvite career_url, and
 * the partner API needs per-customer credentials. So slugs have to be GUESSED and verified.
 *
 * The guess space comes from the 106k companies we already track — their domains and names —
 * because Jobvite slugs are overwhelmingly just the company's own name or domain label
 * (jobs.jobvite.com/uplight, /ookla). We are not discovering companies, we are discovering
 * which of the companies we ALREADY know are on Jobvite.
 *
 * Verification is a HEAD with redirect:'manual', which is the whole trick that makes probing
 * ~100k candidates affordable:
 *
 *   valid slug   -> 200, no body transferred
 *   invalid slug -> 302, Location: http://search.jobvite.com?invalid=1
 *
 * ~300ms per probe and zero bandwidth. A plain GET would pull 15-45KB per hit, and following
 * the redirect would pull Jobvite's entire marketing homepage for every MISS.
 *
 *   node scripts/discover-jobvite.js
 *
 *   OUT          results JSONL          (default data/jobvite-slugs.jsonl)
 *   CHECKPOINT   resume file            (default data/jobvite-discovery.checkpoint)
 *   CONCURRENCY  parallel probes        (default 8)
 *   LIMIT        stop after N candidates (0 = all)
 *   VERIFY_JOBS  1 = also fetch each hit's board to count real openings (default 1)
 *   INSERT       1 = write confirmed boards into companies (default 0, report only)
 *
 * Report-only by default: discovery should not mutate the company universe until the hit list
 * has been eyeballed.
 */
const fs = require('fs');
const path = require('path');
const { query } = require('../src/db/connection');
const jobvite = require('../src/adapters/jobvite');

const OUT = process.env.OUT || path.join(__dirname, '..', 'data', 'jobvite-slugs.jsonl');
const CHECKPOINT = process.env.CHECKPOINT || path.join(__dirname, '..', 'data', 'jobvite-discovery.checkpoint');
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '8', 10);
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const VERIFY_JOBS = process.env.VERIFY_JOBS !== '0';
const INSERT = process.env.INSERT === '1';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

// Slugs that are real Jobvite pages but not a company board, or that match so many of our
// companies that they are certain false positives.
const SLUG_BLOCKLIST = new Set(['careers', 'jobs', 'search', 'company', 'test', 'demo', 'www', 'app']);

/** "Blue Origin, Inc." -> "blueorigin"; also yields the hyphenated form. */
function slugCandidates(name, domain) {
  const out = new Set();
  const clean = (s) => String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // strip diacritics
    .toLowerCase()
    // Legal suffixes are never part of a Jobvite slug and would otherwise generate
    // "acmeinc" alongside "acme", doubling the probe count for zero extra hits.
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|plc|sa|bv|ag|pty|group|holdings)\b/g, ' ')
    .trim();

  if (domain) {
    // Second-level label: "careers.blueorigin.co.uk" -> "blueorigin"
    const host = String(domain).replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
    const parts = host.split('.').filter((p) => p && p !== 'www');
    if (parts.length >= 2) {
      const sld = parts[parts.length - 2] === 'co' || parts[parts.length - 2] === 'com'
        ? parts[parts.length - 3] : parts[parts.length - 2];
      if (sld) out.add(sld.replace(/[^a-z0-9-]/g, ''));
    } else if (parts.length === 1) {
      out.add(parts[0].replace(/[^a-z0-9-]/g, ''));
    }
  }
  const n = clean(name);
  if (n) {
    out.add(n.replace(/[^a-z0-9]/g, ''));       // "blue origin" -> blueorigin
    // Collapse and trim hyphens: stripping a legal suffix leaves a trailing space, which
    // previously produced "blue-origin-" for "Blue Origin, Inc." — a slug that can never hit.
    out.add(n.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')); // -> blue-origin
  }
  return [...out].filter((s) => s && s.length >= 3 && s.length <= 40
    && !/^\d+$/.test(s) && !SLUG_BLOCKLIST.has(s));
}

/**
 * 200 = real board, 302 = no such slug. Anything else is inconclusive.
 *
 * Retried, because a bare single attempt produced 39,866 errors across 121,361 candidates on the
 * first run — a third of the search space, lost to transient connection failures under sustained
 * concurrency rather than to anything about the slugs. Two extra attempts with a short backoff
 * turn nearly all of those into a definitive hit or miss.
 */
async function probe(slug, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`https://jobs.jobvite.com/${encodeURIComponent(slug)}`, {
        method: 'HEAD',
        headers: HEADERS,
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 200) return 'hit';
      if (res.status === 302 || res.status === 301) return 'miss';
      // 403/429 mean Cloudflare is pushing back — surfaced so the caller can slow down rather
      // than silently recording thousands of false misses. Not retried here: the caller backs
      // off and re-queues, which is the correct response to being throttled.
      if (res.status === 403 || res.status === 429) return 'blocked';
      return 'other';
    } catch {
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  return 'error';
}

async function main() {
  const done = new Set();
  if (fs.existsSync(CHECKPOINT)) {
    fs.readFileSync(CHECKPOINT, 'utf8').split('\n').forEach((l) => l.trim() && done.add(l.trim()));
    console.log(`checkpoint: ${done.size} slugs already probed`);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  // Successfully-synced companies first: they are verified-real organisations, so a hit there
  // is immediately actionable, and it front-loads the useful results in a multi-hour run.
  //
  // Ordering deliberately uses last_synced_at rather than a live-job count. The obvious
  // `(SELECT COUNT(*) FROM jobs WHERE company_id = c.id AND removed_at IS NULL)` is a
  // correlated subquery run once per company — across 106k companies against a 28GB jobs table
  // it blew the statement timeout before a single slug was probed.
  const { rows } = await query(
    `SELECT company_name, domain, ats, status
       FROM companies
      ORDER BY (status = 'active') DESC, last_synced_at DESC NULLS LAST`
  );

  // slug -> the first company that suggested it (for reporting)
  const candidates = new Map();
  for (const c of rows) {
    for (const s of slugCandidates(c.company_name, c.domain)) {
      if (!candidates.has(s) && !done.has(s)) candidates.set(s, c);
    }
  }
  let list = [...candidates.entries()];
  if (LIMIT > 0) list = list.slice(0, LIMIT);
  console.log(`${rows.length} companies -> ${candidates.size} unprobed slug candidates` +
    (LIMIT ? ` (limited to ${list.length})` : ''));

  const outStream = fs.createWriteStream(OUT, { flags: 'a' });
  const ckStream = fs.createWriteStream(CHECKPOINT, { flags: 'a' });
  const stats = { hit: 0, miss: 0, blocked: 0, other: 0, error: 0, withJobs: 0, jobsTotal: 0 };
  const started = Date.now();
  let i = 0, blockedStreak = 0;

  const worker = async () => {
    while (i < list.length) {
      const [slug, company] = list[i++];
      const r = await probe(slug);
      stats[r]++;

      if (r === 'blocked') {
        // Back off hard and re-queue: recording this as a miss would poison the results.
        blockedStreak++;
        i--;
        const wait = Math.min(120, 10 * blockedStreak);
        console.log(`  blocked by Cloudflare — backing off ${wait}s`);
        await new Promise((res) => setTimeout(res, wait * 1000));
        continue;
      }
      blockedStreak = 0;
      // ONLY a definitive answer is checkpointed. A network error is not evidence that the slug
      // does not exist, and the first run wrote those to the checkpoint anyway — 39,866 of
      // 121,361 candidates (33%) were recorded as probed without ever having been tested, and
      // could never be retried. Leaving them out means a rerun picks them up.
      if (r === 'hit' || r === 'miss') ckStream.write(slug + '\n');

      if (r === 'hit') {
        let jobCount = null, companyName = null;
        if (VERIFY_JOBS) {
          // A 200 proves the slug exists, not that anyone is hiring. Reading the board
          // separates live boards from parked ones before anything gets imported.
          try {
            const { jobs, meta } = await jobvite.fetchJobs(slug);
            jobCount = jobs.length;
            companyName = meta.companyName;
          } catch { jobCount = -1; }
        }
        if (jobCount > 0) { stats.withJobs++; stats.jobsTotal += jobCount; }
        outStream.write(JSON.stringify({
          slug, jobs: jobCount, jobviteName: companyName,
          matchedCompany: company.company_name, domain: company.domain,
          currentAts: company.ats, currentStatus: company.status,
        }) + '\n');
        console.log(`  HIT ${slug}  jobs=${jobCount ?? '?'}  (${companyName || company.company_name})`);
      }

      if ((stats.hit + stats.miss) % 2000 === 0) {
        const mins = (Date.now() - started) / 60000;
        console.log(`[${new Date().toISOString()}] probed=${stats.hit + stats.miss}/${list.length} ` +
          `hits=${stats.hit} withJobs=${stats.withJobs} jobs=${stats.jobsTotal} ` +
          `${Math.round((stats.hit + stats.miss) / Math.max(mins, 0.01))}/min`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  outStream.end(); ckStream.end();

  console.log(`\ndone: ${JSON.stringify(stats)}`);
  console.log(`hit rate: ${(100 * stats.hit / Math.max(stats.hit + stats.miss, 1)).toFixed(2)}%`);
  console.log(`results: ${OUT}`);
  if (!INSERT) console.log('report only — rerun with INSERT=1 to add confirmed boards to companies');
  process.exit(0);
}

main().catch((err) => { console.error('fatal:', err.message); process.exit(1); });
