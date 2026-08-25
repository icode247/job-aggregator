/**
 * Shared helpers for the direct-employer adapters (Amazon, Netflix, Google, ...).
 *
 * These are NOT ATS integrations. Every other adapter in this directory talks to a vendor
 * (Greenhouse, Workday, Jobvite) that serves hundreds of tenants behind one API shape, so one
 * adapter covers every customer. These six talk to a SINGLE employer's bespoke careers backend,
 * so each adapter covers exactly one company and the `slug` argument is a shard selector rather
 * than a tenant id.
 *
 * THE SYNC CONTRACT IS WHY THAT MATTERS. jobsRepo.syncForCompany marks every stored job absent
 * from an incoming set as removed (behind a >50%-missing guard). So `fetchJobs` must return the
 * COMPLETE set it claims to represent — a partial sweep would retire the half it did not reach.
 * Where an employer's API caps how deep we can page, the adapter must say so out loud rather
 * than quietly returning a slice, which is what `capped` on the returned meta is for.
 */

const REMOTE_RE = /\b(remote|work from home|wfh|virtual|distributed|anywhere)\b/i;
const HYBRID_RE = /\bhybrid\b/i;
const ONSITE_RE = /\b(on-?site|in-?office|in-?person)\b/i;

/**
 * Workplace type from the STRUCTURED fields only — title, location, and any explicit
 * workplace field the employer provides. Never from the job description.
 *
 * PASSING A DESCRIPTION HERE IS A BUG, and an expensive one. The first cut of the Amazon adapter
 * did exactly that and mislabelled 52 of 100 sampled jobs as remote. Every single one of those 52
 * matched on description text and NONE on title or location, i.e. a 100% false-positive rate.
 * What they actually matched:
 *
 *   "Amazon WorkSpaces enables you to provision virtual, cloud-based Windows..."  (product copy)
 *   "Please note these are not remote positions"                                 (the negation!)
 *
 * A job description is prose about the product and the team; the words "remote", "virtual" and
 * "distributed" appear in it constantly with no bearing on where the person sits. `remote` is a
 * user-facing filter, so a wrong value is worse than no value — it sends a candidate to a job
 * they cannot take. Structured fields only.
 *
 * Order matters: "Hybrid Remote" is hybrid, not remote, and several of these employers use
 * exactly that phrasing. Checking remote first would mislabel every hybrid role in the corpus.
 */
function inferWorkplace({ title, location, workplaceField } = {}) {
  const s = [title, location, workplaceField].filter(Boolean).join(' ');
  if (!s) return null;
  // Cheap guard for an explicit denial sitting in a structured field, e.g. a location literally
  // reading "Not remote". Rare, but the cost of getting it wrong is a broken filter.
  if (/\bnot\s+(remote|hybrid)\b/i.test(s)) return 'onsite';
  if (HYBRID_RE.test(s)) return 'hybrid';
  if (REMOTE_RE.test(s)) return 'remote';
  if (ONSITE_RE.test(s)) return 'onsite';
  return null;
}

/** Strip tags and collapse whitespace, keeping paragraph breaks readable. */
function htmlToText(html) {
  if (!html) return null;
  const text = String(html)
    .replace(/<\s*(br|\/p|\/div|\/li)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

/**
 * Epoch seconds / milliseconds / date string -> ISO, or null.
 *
 * Netflix sends `t_update` in SECONDS while most sources send milliseconds, and a seconds value
 * read as milliseconds lands in 1970 — which then reads as "posted 56 years ago" on the board and
 * sorts to the bottom of every freshness filter. The 1e11 threshold separates them: any real
 * millisecond timestamp for a live job is far above it, any second timestamp far below.
 */
function toIso(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value);
    const ms = n < 1e11 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Simple bounded-concurrency map, same shape the other adapters use. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; }
      }
    })
  );
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch with retry on transient failures.
 *
 * These are single-employer endpoints with no vendor SLA behind them and they rate-limit on
 * bursts, so a bare fetch turns an ordinary 429 into "this company has no jobs" — which the sync
 * would then act on by retiring the entire board. Retrying 429/5xx is what keeps a throttle from
 * being mistaken for a closure.
 */
async function fetchJson(url, { headers = {}, timeoutMs = 25000, attempts = 3, body = null, method = 'GET' } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { Accept: 'application/json', ...headers },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(1000 * (attempt + 1) ** 2);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < attempts - 1) await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr || new Error('request failed');
}

module.exports = { inferWorkplace, htmlToText, toIso, mapLimit, fetchJson, sleep };
