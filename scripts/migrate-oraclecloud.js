#!/usr/bin/env node
/**
 * One-time migration: fold 'oraclecloud' companies into the 'oracle' adapter.
 *
 * 'oraclecloud' is the same platform as 'oracle' but (1) isn't a registered adapter
 * key (would throw "Unsupported ATS") and (2) its slugs are bare tenants (e.g. "eiqg")
 * with no region/siteNumber, so the oracle adapter can't build a URL.
 *
 * This script reconstructs "tenant.region" from each career_url
 * ({tenant}.fa.{region}.oraclecloud.com), probes for a working Oracle CE siteNumber,
 * and ONLY converts tenants that actually resolve to a job site — baking the
 * discovered siteNumber into the slug so future syncs skip discovery.
 *
 *   DB_URL=$(heroku config:get DATABASE_URL -a fastapply-board) node scripts/migrate-oraclecloud.js
 *   DRY_RUN=1 ... node scripts/migrate-oraclecloud.js   # validate, no writes
 *
 * Env: CONCURRENCY (default 12), PROBE_TIMEOUT ms (default 7000), DRY_RUN.
 */
const { Client } = require('pg');

const COMMON_SITES = ['CX', 'CX_1', 'CX_1001', 'CX_45001', 'CX_1003', 'CX_2001', 'CX_1002'];
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '12', 10);
const PROBE_TIMEOUT = parseInt(process.env.PROBE_TIMEOUT || '7000', 10);
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

function reconstruct(careerUrl) {
  try {
    const host = new URL(careerUrl).hostname; // {tenant}.fa.{region}.oraclecloud.com
    const parts = host.split('.');
    const faIdx = parts.indexOf('fa');
    if (faIdx < 1 || !parts[faIdx + 1]) return null;
    return { tenant: parts[0], region: parts[faIdx + 1] };
  } catch { return null; }
}

async function probeSite(tenant, region) {
  const base = `https://${tenant}.fa.${region}.oraclecloud.com/hcmRestApi/resources/latest`;
  for (const site of COMMON_SITES) {
    try {
      const url = `${base}/recruitingCEJobRequisitions?onlyData=true&finder=findReqs;siteNumber=${site},limit=1,sortBy=POSTING_DATES_DESC`;
      const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT) });
      if (!res.ok) continue;
      const data = await res.json();
      const item = data.items?.[0];
      const count = item?.TotalJobsCount ?? (item?.requisitionList?.length || 0);
      if (count > 0) return { site, count };
    } catch { /* try next site */ }
  }
  return null;
}

async function runPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

(async () => {
  if (!process.env.DB_URL) { console.error('DB_URL not set'); process.exit(1); }
  const c = new Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
  c.on('error', () => {});
  await c.connect();

  const { rows } = await c.query(
    "SELECT id, ats_slug, career_url FROM companies WHERE ats='oraclecloud'"
  );
  console.log(`oraclecloud companies: ${rows.length} | mode: ${DRY_RUN ? 'DRY_RUN' : 'APPLY'} | concurrency ${CONCURRENCY}\n`);

  // Cache probes per tenant.region (multiple companies can share one).
  const probeCache = new Map();
  let badUrl = 0;

  const enriched = rows.map(r => {
    const rec = reconstruct(r.career_url);
    if (!rec) badUrl++;
    return { ...r, rec };
  });

  let done = 0;
  const evaluated = await runPool(enriched.filter(e => e.rec), CONCURRENCY, async (e) => {
    const key = `${e.rec.tenant}.${e.rec.region}`;
    let probe = probeCache.get(key);
    if (probe === undefined) { probe = await probeSite(e.rec.tenant, e.rec.region); probeCache.set(key, probe); }
    done++;
    if (done % 25 === 0) console.log(`  probed ${done}/${enriched.length}...`);
    return { ...e, probe };
  });

  const live = evaluated.filter(e => e.probe);
  const dead = evaluated.filter(e => !e.probe);
  const liveTenants = new Set(live.map(e => `${e.rec.tenant}.${e.rec.region}`));

  console.log(`\n--- validation ---`);
  console.log(`  bad/unparseable career_url: ${badUrl}`);
  console.log(`  resolved (live job site):   ${live.length} companies across ${liveTenants.size} tenants`);
  console.log(`  no siteNumber resolved:     ${dead.length}`);
  if (live.length) {
    const totalJobs = live.reduce((s, e) => s + (e.probe.count || 0), 0);
    console.log(`  approx jobs available across live tenants: ~${totalJobs.toLocaleString()}`);
    console.log(`  sample: ${live.slice(0, 6).map(e => `${e.rec.tenant}.${e.rec.region}.${e.probe.site}(${e.probe.count})`).join(', ')}`);
  }

  if (DRY_RUN) { console.log('\nDRY_RUN — no DB writes.'); await c.end(); return; }

  // Convert resolved companies to the oracle adapter with baked siteNumber.
  let converted = 0;
  for (const e of live) {
    const newSlug = `${e.rec.tenant}.${e.rec.region}.${e.probe.site}`;
    await c.query(
      "UPDATE companies SET ats='oracle', ats_slug=$1, error_message=NULL, updated_at=NOW() WHERE id=$2",
      [newSlug, e.id]
    );
    converted++;
  }
  // Document the dead ones (kept as oraclecloud, inert) so they're not silently lost.
  for (const e of dead) {
    await c.query(
      "UPDATE companies SET error_message='oraclecloud: no CE siteNumber resolved (probed common sites)', updated_at=NOW() WHERE id=$1",
      [e.id]
    );
  }
  console.log(`\nAPPLIED: converted ${converted} -> oracle (will sync next cycle); flagged ${dead.length} dead.`);
  await c.end();
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
