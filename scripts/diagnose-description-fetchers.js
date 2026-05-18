#!/usr/bin/env node
/**
 * Diagnose why the description backfill is failing 100% for zoho, lever,
 * smartrecruiters, and workday.
 *
 * Pulls real jobs missing descriptions from each ATS, runs the fetcher
 * inline with full step-by-step logging, and classifies the failure mode
 * (HTTP 4xx/5xx, parse failure, empty body, missing field, timeout, etc.).
 *
 * Read-only by default. Pass --apply to UPDATE rows where the fetch succeeds.
 *
 * Usage:
 *   DATABASE_URL=$(heroku config:get DATABASE_URL -a fastapply-board) \
 *     node scripts/diagnose-description-fetchers.js
 *
 *   # Restrict to one ATS, more samples, and write successes back:
 *   DATABASE_URL=... node scripts/diagnose-description-fetchers.js \
 *     --ats=zoho --samples=10 --apply
 */

'use strict';

const { Pool } = require('pg');

// ---------- CLI args ----------
const args = process.argv.slice(2);
const argFor = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const APPLY     = args.includes('--apply');
const ATS_FILTER = argFor('ats', null);                       // e.g. zoho
const SAMPLES    = parseInt(argFor('samples', '3'), 10);      // jobs per ATS
const TIMEOUT_MS = parseInt(argFor('timeout', '10000'), 10);

const TARGET_ATSES = ATS_FILTER
  ? [ATS_FILTER]
  : ['zoho', 'lever', 'smartrecruiters', 'workday'];

// ---------- DB ----------
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set.');
  console.error('Hint: DATABASE_URL=$(heroku config:get DATABASE_URL -a fastapply-board) \\');
  console.error('        node scripts/diagnose-description-fetchers.js');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 4,
  connectionTimeoutMillis: 10000,
});

// ---------- helpers ----------
const preview = (s, n = 400) => {
  if (s == null) return '<null>';
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str.length > n ? str.slice(0, n) + ` …[${str.length - n} more chars]` : str;
};

const banner = (line) => console.log('\n' + '═'.repeat(78) + '\n' + line + '\n' + '═'.repeat(78));
const sub    = (line) => console.log('\n── ' + line + ' ' + '─'.repeat(Math.max(0, 73 - line.length)));

async function timedFetch(url, opts = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { ok: true, res, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, err, ms: Date.now() - t0 };
  }
}

// ---------- per-ATS instrumented probes ----------

/** zoho — scrape job.url HTML, extract embedded JSON. */
async function probeZoho(job) {
  if (!job.url) return { mode: 'NO_URL', description: null };
  console.log(`  GET ${job.url}`);
  const r = await timedFetch(job.url);
  if (!r.ok) return { mode: r.err.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR', err: r.err.message };
  console.log(`  → ${r.res.status} (${r.ms}ms) ct=${r.res.headers.get('content-type') || '?'}`);
  if (!r.res.ok) {
    const body = await r.res.text().catch(() => '');
    return { mode: `HTTP_${r.res.status}`, bodyPreview: preview(body) };
  }
  const html = await r.res.text();
  console.log(`  body length: ${html.length} chars`);
  const match = html.match(/var\s+jobs\s*=\s*JSON\.parse\('(.+?)'\)/);
  if (!match) {
    // Show what we got instead so we can adapt the parser.
    console.log(`  body preview: ${preview(html, 600)}`);
    return { mode: 'PARSE_FAIL_NO_REGEX', bodyPreview: preview(html) };
  }
  console.log(`  regex matched, payload length: ${match[1].length}`);
  let raw = match[1].replace(/\\x22/g, '"').replace(/\\x27/g, "'");
  raw = raw.replace(/\\\\"/g, '\\"').replace(/\\\\:/g, ':').replace(/\\\\\//g, '/');
  try {
    const parsed = JSON.parse(raw);
    const jobData = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!jobData?.Job_Description) {
      console.log(`  keys in payload: ${Object.keys(jobData || {}).slice(0, 20).join(', ')}`);
      return { mode: 'MISSING_FIELD_Job_Description', keys: Object.keys(jobData || {}) };
    }
    return { mode: 'SUCCESS', description: jobData.Job_Description };
  } catch (e) {
    return { mode: 'PARSE_FAIL_JSON', err: e.message, rawPreview: preview(raw) };
  }
}

/** lever — public v0 API. */
async function probeLever(job) {
  const jobId = job.external_id.replace('lever_', '');
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(job.ats_slug)}/${jobId}`;
  console.log(`  GET ${url}`);
  const r = await timedFetch(url);
  if (!r.ok) return { mode: r.err.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR', err: r.err.message };
  console.log(`  → ${r.res.status} (${r.ms}ms)`);
  if (!r.res.ok) {
    const body = await r.res.text().catch(() => '');
    return { mode: `HTTP_${r.res.status}`, bodyPreview: preview(body) };
  }
  const data = await r.res.json().catch((e) => ({ __parseErr: e.message }));
  if (data.__parseErr) return { mode: 'PARSE_FAIL_JSON', err: data.__parseErr };
  const desc = data.descriptionPlain || data.description;
  if (!desc) {
    console.log(`  keys: ${Object.keys(data).slice(0, 20).join(', ')}`);
    return { mode: 'MISSING_FIELD_description', keys: Object.keys(data) };
  }
  return { mode: 'SUCCESS', description: desc };
}

/** smartrecruiters — public posting API. */
async function probeSmartRecruiters(job) {
  const postingId = job.external_id.replace('smartrecruiters_', '');
  const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(job.ats_slug)}/postings/${postingId}`;
  console.log(`  GET ${url}`);
  const r = await timedFetch(url);
  if (!r.ok) return { mode: r.err.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR', err: r.err.message };
  console.log(`  → ${r.res.status} (${r.ms}ms)`);
  if (!r.res.ok) {
    const body = await r.res.text().catch(() => '');
    return { mode: `HTTP_${r.res.status}`, bodyPreview: preview(body) };
  }
  const data = await r.res.json().catch((e) => ({ __parseErr: e.message }));
  if (data.__parseErr) return { mode: 'PARSE_FAIL_JSON', err: data.__parseErr };
  if (!data?.jobAd?.sections) {
    console.log(`  top-level keys: ${Object.keys(data).join(', ')}`);
    console.log(`  jobAd keys: ${data.jobAd ? Object.keys(data.jobAd).join(', ') : '<no jobAd>'}`);
    return { mode: 'MISSING_FIELD_jobAd.sections', hasJobAd: !!data.jobAd };
  }
  // Build description the same way the live fetcher does (best-effort reproduction):
  const sections = data.jobAd.sections;
  const parts = [];
  for (const [k, v] of Object.entries(sections)) {
    if (v?.text) parts.push(`${v.title || k}\n${v.text}`);
  }
  const desc = parts.join('\n\n');
  return { mode: desc ? 'SUCCESS' : 'EMPTY_DESCRIPTION', description: desc };
}

/** workday — robots.txt discovery + cxs detail endpoint. */
async function probeWorkday(job) {
  const rawData = typeof job.raw_data === 'string' ? JSON.parse(job.raw_data) : job.raw_data;
  const externalPath = rawData?.externalPath;
  console.log(`  externalPath: ${externalPath || '<missing>'}`);
  if (!externalPath) return { mode: 'MISSING_externalPath', rawKeys: Object.keys(rawData || {}) };

  // Discover wdN + siteSlugs via robots.txt
  let discovered = null;
  for (const wd of [1, 2, 3, 5, 12]) {
    const robotsUrl = `https://${job.ats_slug}.wd${wd}.myworkdayjobs.com/robots.txt`;
    const rr = await timedFetch(robotsUrl);
    if (!rr.ok || !rr.res.ok) {
      console.log(`  robots wd${wd}: ${rr.ok ? rr.res.status : rr.err.message}`);
      continue;
    }
    const text = await rr.res.text();
    const matches = [...text.matchAll(/myworkdayjobs\.com\/([^/\s]+)/g)];
    if (matches.length === 0) {
      console.log(`  robots wd${wd}: 200 but no siteSlugs in body`);
      continue;
    }
    discovered = { wdNum: wd, siteSlugs: [...new Set(matches.map((m) => m[1]))] };
    console.log(`  ✓ discovered wd${wd}, siteSlugs=${discovered.siteSlugs.join(',')}`);
    break;
  }
  if (!discovered) return { mode: 'NO_WORKDAY_HOST' };

  for (const siteSlug of discovered.siteSlugs) {
    const url = `https://${job.ats_slug}.wd${discovered.wdNum}.myworkdayjobs.com/wday/cxs/${job.ats_slug}/${siteSlug}${externalPath}`;
    console.log(`  GET ${url}`);
    const r = await timedFetch(url);
    if (!r.ok) { console.log(`  → ${r.err.message}`); continue; }
    console.log(`  → ${r.res.status} (${r.ms}ms)`);
    if (r.res.status === 403) {
      const body = await r.res.text().catch(() => '');
      return { mode: 'HTTP_403', bodyPreview: preview(body) };
    }
    if (!r.res.ok) continue;
    const detail = await r.res.json().catch((e) => ({ __parseErr: e.message }));
    if (detail.__parseErr) return { mode: 'PARSE_FAIL_JSON', err: detail.__parseErr };
    const desc = detail?.jobPostingInfo?.jobDescription;
    if (!desc) {
      console.log(`  keys: ${Object.keys(detail).slice(0, 20).join(', ')}`);
      console.log(`  jobPostingInfo keys: ${detail.jobPostingInfo ? Object.keys(detail.jobPostingInfo).slice(0, 20).join(', ') : '<missing>'}`);
      return { mode: 'MISSING_FIELD_jobDescription' };
    }
    return { mode: 'SUCCESS', description: desc };
  }
  return { mode: 'ALL_SITESLUGS_4XX' };
}

const PROBES = {
  zoho:            probeZoho,
  lever:           probeLever,
  smartrecruiters: probeSmartRecruiters,
  workday:         probeWorkday,
};

// ---------- main ----------
async function main() {
  banner(`Description fetcher diagnostic`
    + `\n  ATSes:   ${TARGET_ATSES.join(', ')}`
    + `\n  samples: ${SAMPLES} per ATS`
    + `\n  apply:   ${APPLY ? 'YES (will UPDATE successful rows)' : 'no (dry run)'}`);

  const summary = {};

  for (const ats of TARGET_ATSES) {
    if (!PROBES[ats]) {
      console.log(`(no probe registered for "${ats}", skipping)`);
      continue;
    }

    sub(`ATS: ${ats}`);
    const { rows: jobs } = await pool.query(
      `SELECT j.id, j.ats, j.external_id, j.url, j.raw_data, c.ats_slug
         FROM jobs j JOIN companies c ON j.company_id = c.id
        WHERE j.removed_at IS NULL
          AND (j.description IS NULL OR j.description = '')
          AND j.ats = $1
        ORDER BY j.first_seen_at DESC
        LIMIT $2`,
      [ats, SAMPLES],
    );
    if (jobs.length === 0) {
      console.log(`  No jobs found missing descriptions for ${ats}.`);
      continue;
    }
    console.log(`  Sampling ${jobs.length} job(s) from ${ats}`);

    summary[ats] = { total: jobs.length, modes: {}, applied: 0 };

    for (const job of jobs) {
      console.log(`\n  • job id=${job.id} slug=${job.ats_slug} external_id=${job.external_id}`);
      console.log(`    url=${job.url || '<none>'}`);

      let outcome;
      try {
        outcome = await PROBES[ats](job);
      } catch (err) {
        outcome = { mode: 'UNCAUGHT', err: err.message, stack: err.stack };
      }

      const mode = outcome.mode || 'UNKNOWN';
      summary[ats].modes[mode] = (summary[ats].modes[mode] || 0) + 1;

      if (mode === 'SUCCESS') {
        console.log(`    ✓ SUCCESS — description ${outcome.description.length} chars`);
        console.log(`    preview: ${preview(outcome.description, 200)}`);
        if (APPLY) {
          await pool.query('UPDATE jobs SET description = $1 WHERE id = $2', [outcome.description, job.id]);
          summary[ats].applied++;
          console.log(`    → written to DB`);
        }
      } else {
        console.log(`    ✗ FAIL: ${mode}`);
        for (const [k, v] of Object.entries(outcome)) {
          if (k === 'mode' || k === 'description') continue;
          console.log(`      ${k}: ${preview(v, 300)}`);
        }
      }
    }
  }

  // ---------- summary ----------
  banner('SUMMARY');
  for (const [ats, s] of Object.entries(summary)) {
    console.log(`\n${ats}: ${s.total} probed`);
    for (const [mode, n] of Object.entries(s.modes).sort((a, b) => b[1] - a[1])) {
      const pct = Math.round((n / s.total) * 100);
      console.log(`  ${String(n).padStart(3)}  ${String(pct).padStart(3)}%  ${mode}`);
    }
    if (APPLY) console.log(`  applied: ${s.applied}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('\nFATAL:', err);
  pool.end().catch(() => {});
  process.exit(1);
});
