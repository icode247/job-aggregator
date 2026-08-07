/**
 * Meilisearch client.
 *
 * Optional by design, following the same shape as the Redis helpers in
 * src/api/middleware/cache.js and src/utils/metrics.js: if MEILI_HOST is unset every call is a
 * no-op and callers fall back to Postgres. Nothing here may throw on a missing service — the
 * board has to keep serving if the index is down.
 *
 * No meilisearch npm package: the REST API is small enough that a dependency buys nothing, and
 * the repo has no shared HTTP wrapper to hang it off anyway.
 */
const logger = require('../logger');
const { countriesFromLocation, locationTokens } = require('./location-countries');

const HOST = process.env.MEILI_HOST || '';
const KEY = process.env.MEILI_MASTER_KEY || '';
const INDEX = process.env.MEILI_INDEX || 'jobs';
const TIMEOUT_MS = parseInt(process.env.MEILI_TIMEOUT_MS || '5000', 10);

const enabled = !!HOST;

async function call(method, path, body, { timeoutMs = TIMEOUT_MS } = {}) {
  if (!enabled) return null;
  const headers = { 'Content-Type': 'application/json' };
  if (KEY) headers.Authorization = `Bearer ${KEY}`;
  const res = await fetch(`${HOST}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const err = new Error(`Meili ${method} ${path} -> ${res.status} ${(json && json.message) || text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function health() {
  if (!enabled) return { ok: false, reason: 'MEILI_HOST unset' };
  try {
    const r = await call('GET', '/health', undefined, { timeoutMs: 3000 });
    return { ok: r && r.status === 'available', raw: r };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Create the index and apply settings. Safe to re-run: Meilisearch treats both as upserts.
 *
 * filterableAttributes is what makes facet counts free — they come back from the same request
 * as the search, instead of being separate GROUP BY scans over 2.8M rows (which is what made
 * /api/facets and /api/roles 40-60s on Postgres).
 *
 * Descriptions are deliberately NOT indexed: title/company/location metadata is ~573MB raw,
 * descriptions are an order of magnitude more, and they would change the plan we need.
 */
async function ensureIndex() {
  if (!enabled) return null;
  await call('POST', '/indexes', { uid: INDEX, primaryKey: 'id' }).catch((err) => {
    if (err.status !== 409) throw err; // 409 = already exists
  });
  return call('PATCH', `/indexes/${INDEX}/settings`, {
    searchableAttributes: ['title', 'company_name', 'department', 'location'],
    filterableAttributes: [
      'ats', 'employment_type', 'workplace_type', 'experience_level',
      'visa_sponsorship', 'is_remote', 'remote_worldwide', 'role_category',
      'company_id', 'location', 'location_countries', 'location_tokens', 'posted_ts',
    ],
    sortableAttributes: ['posted_ts', 'first_seen_ts'],
    // Match the board's ordering: freshness first. Meilisearch still applies its relevance
    // ranking above this, which is the point — Postgres could only sort by date.
    rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness', 'first_seen_ts:desc'],
    pagination: { maxTotalHits: 10000 },
  });
}

/** Push a batch of documents. Meilisearch upserts on primaryKey and returns a task, not a result. */
async function addDocuments(docs) {
  if (!enabled || !docs.length) return null;
  return call('POST', `/indexes/${INDEX}/documents`, docs, { timeoutMs: 30000 });
}

async function deleteDocuments(ids) {
  if (!enabled || !ids.length) return null;
  return call('POST', `/indexes/${INDEX}/documents/delete-batch`, ids, { timeoutMs: 30000 });
}

async function search(params) {
  if (!enabled) return null;
  return call('POST', `/indexes/${INDEX}/search`, params);
}

async function stats() {
  if (!enabled) return null;
  return call('GET', `/indexes/${INDEX}/stats`);
}

/**
 * Map a jobs row to an index document.
 *
 * Dates become epoch seconds because Meilisearch can only filter and sort numerically —
 * a timestamp string would sort lexicographically and break "posted in the last 24h".
 * salary_min/max are TEXT in Postgres (schema.js), so they are coerced here or they would
 * arrive as strings and be unusable in a numeric filter.
 */
function toDocument(row) {
  const ts = (v) => (v ? Math.floor(new Date(v).getTime() / 1000) : null);
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  return {
    id: row.id,
    external_id: row.external_id,
    title: row.title,
    department: row.department || null,
    location: row.location || null,
    // Countries resolved once, here, so the query side needs no substring matching. Postgres
    // matches short aliases (us/uk/uae) with a word-boundary regex; Meilisearch has no such
    // operator, and CONTAINS "us" would return Houston. An exact filter on this sidesteps both.
    location_countries: countriesFromLocation(row.location),
    // The same trick for cities and regions. `location CONTAINS "london"` is an unindexed
    // substring scan — measured 8,589ms against 47ms for the indexed country equality, ~180x —
    // and it blew past the client's 5s timeout, so those searches silently fell back to a 6.5s
    // Postgres query. Tokenising here turns the query side into `location_tokens = "london"`,
    // an exact filter the index actually serves.
    location_tokens: locationTokens(row.location),
    workplace_type: row.workplace_type || null,
    employment_type: row.employment_type || null,
    experience_level: row.experience_level || null,
    visa_sponsorship: row.visa_sponsorship || null,
    role_category: row.role_category || null,
    is_remote: !!row.is_remote,
    remote_worldwide: !!row.remote_worldwide,
    ats: row.ats,
    url: row.url,
    salary_min: num(row.salary_min),
    salary_max: num(row.salary_max),
    salary_currency: row.salary_currency || null,
    salary_interval: row.salary_interval || null,
    posted_at: row.posted_at || null,
    // The board sorts and filters on "posted", which falls back to first_seen_at when the
    // source gave no date — same COALESCE the SQL path uses.
    posted_ts: ts(row.posted_at || row.first_seen_at),
    first_seen_ts: ts(row.first_seen_at),
    company_id: row.company_id,
    company_name: row.company_name || null,
    company_domain: row.domain || null,
    company_ats_slug: row.ats_slug || null,
    company_logo_url: row.logo_url || null,
  };
}

module.exports = {
  enabled, INDEX, HOST,
  health, ensureIndex, addDocuments, deleteDocuments, search, stats, toDocument, call,
};
