#!/usr/bin/env node
/**
 * Pull AI-enriched job listings from the Apify actor
 * "fantastic-jobs/career-site-job-listing-feed" for the full cross-industry role
 * vocabulary (scripts/job-roles.js ALL_ROLES) and upsert into Heroku Postgres.
 *
 * The actor silently returns ~nothing when given a very large titleSearch array,
 * so titles are BATCHED into chunks (~60) and each chunk is its own actor run.
 * Company de-dup + job de-dup are shared across all chunks. Stops cleanly on
 * credit/usage exhaustion.
 *
 *   APIFY_TOKEN=... DB_URL=$(heroku config:get DATABASE_URL -a fastapply-board) \
 *   node scripts/fetch-fantastic-jobs.js
 *
 * Env: APIFY_TOKEN, DB_URL (required); LIMIT (per-chunk, default 2000; actor max 10000),
 *      ATS (csv), CHUNK_SIZE (60), CHUNK_START (0 resume), TITLES ('|'-sep override).
 */
const { Client } = require('pg');
const { ALL_ROLES } = require('./job-roles.js');

const ACTOR = 'fantastic-jobs~career-site-job-listing-feed';
// The actor silently returns nothing for very large title arrays, so titles are
// batched. Per-chunk limit kept modest to spread credit across all industries.
const LIMIT = parseInt(process.env.LIMIT || '2000', 10);
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '60', 10);
const CHUNK_START = parseInt(process.env.CHUNK_START || '0', 10);
// Default to ATS that are net-new or paused for us (avoid the ones we sync fresh,
// which would only create duplicates). Empty ATS cost nothing (billed per result).
const DEFAULT_ATS = 'bamboohr,recruitee,jazzhr,rippling,personio,zoho,comeet,pinpoint,teamtailor,hibob,gem,dover,jobvite,workable,breezy,successfactors,taleo,paycor,ultipro,dayforce';
const ATS = (process.env.ATS || DEFAULT_ATS).split(',').map(s => s.trim()).filter(Boolean);
const TITLE_SEARCH = process.env.TITLES ? process.env.TITLES.split('|').map(s => s.trim()).filter(Boolean) : ALL_ROLES;

const API = 'https://api.apify.com/v2';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TRANSIENT = /EADDRNOTAVAIL|ECONNRESET|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network|not queryable|connection|terminat|timeout|50\d/i;
const isTransient = (e) => !!e && (e.name === 'TimeoutError' || TRANSIENT.test(e.message || '') || TRANSIENT.test(e.cause?.code || ''));
const H = () => ({ 'Authorization': `Bearer ${process.env.APIFY_TOKEN}`, 'Content-Type': 'application/json' });

function truncBytes(s, max = 2600) {
  if (s == null) return s;
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  return Buffer.from(s, 'utf8').subarray(0, max).toString('utf8').replace(/�+$/, '');
}
function mapExp(v) {
  if (!v) return null;
  const s = String(v).toLowerCase();
  if (/intern/.test(s)) return 'internship';
  if (/exec|c-level|\bvp\b|chief|director/.test(s)) return 'executive';
  if (/senior|staff|principal|\bsr\b|lead/.test(s)) return 'senior';
  if (/entry|junior|\bjr\b|graduate/.test(s)) return 'entry';
  if (/\bmid\b|associate/.test(s)) return 'mid';
  const nums = s.match(/\d+/g);
  if (nums) { const max = Math.max(...nums.map(Number)); if (max <= 2) return 'entry'; if (max <= 5) return 'mid'; return 'senior'; }
  return null;
}
function mapWorkplace(v) {
  if (!v) return null;
  const s = String(v).toLowerCase();
  if (s.includes('remote')) return 'remote';
  if (s.includes('hybrid')) return 'hybrid';
  if (s.includes('office') || s.includes('on-site') || s.includes('on site') || s.includes('in-person')) return 'onsite';
  return null;
}
function mapVisa(v) {
  if (v === true) return 'yes'; if (v === false) return 'no';
  if (!v) return '';
  const s = String(v).toLowerCase();
  if (/yes|available|sponsor/.test(s) && !/no |not /.test(s)) return 'yes';
  if (/no\b|not /.test(s)) return 'no';
  return '';
}
// Resolve company (career_url) + a job id from a job URL across ATS URL shapes.
function parseSrc(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const seg = u.pathname.split('/').filter(Boolean);
    const last = seg[seg.length - 1] || null;
    if (host.includes('greenhouse.io')) return { host, slug: seg[0], careerUrl: `https://boards.greenhouse.io/${seg[0]}`, jobId: seg[seg.indexOf('jobs') + 1] || last };
    if (host.includes('lever.co')) return { host, slug: seg[0], careerUrl: `https://jobs.lever.co/${seg[0]}`, jobId: last };
    if (host.includes('ashbyhq.com')) return { host, slug: seg[0], careerUrl: `https://jobs.ashbyhq.com/${seg[0]}`, jobId: last };
    if (host.includes('smartrecruiters.com')) return { host, slug: seg[0], careerUrl: `https://careers.smartrecruiters.com/${seg[0]}`, jobId: last };
    if (host.includes('workable.com')) { const co = (host.split('.')[0] !== 'apply' && host.split('.')[0] !== 'jobs') ? host.split('.')[0] : seg[0]; return { host, slug: co, careerUrl: `https://${co}.workable.com`, jobId: last }; }
    return { host, slug: host.split('.')[0], careerUrl: `https://${host}/careers`, jobId: last };
  } catch { return null; }
}
function loc(j) {
  if (Array.isArray(j.locations) && j.locations.length) return j.locations.filter(Boolean).join('; ');
  if (Array.isArray(j.locations_derived) && j.locations_derived.length) return j.locations_derived.filter(Boolean).join('; ');
  return null;
}
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

async function apiGET(path, attempt = 0) {
  try {
    const res = await fetch(`${API}${path}`, { headers: H(), signal: AbortSignal.timeout(60000) });
    if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`GET ${res.status}`), { retryable: true });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  } catch (e) { if ((e.retryable || isTransient(e)) && attempt < 5) { await sleep(2000 * (attempt + 1)); return apiGET(path, attempt + 1); } throw e; }
}

async function startRun(titles) {
  const input = {
    aiHasSalary: false, aiVisaSponsorshipFilter: false, ats: ATS, includeAi: true, includeLinkedIn: false,
    limit: LIMIT, populateAiRemoteLocation: false, populateAiRemoteLocationDerived: false, 'remote only (legacy)': false,
    removeAgency: false, titleSearch: titles, includeCompanyDetails: false, hasSalary: false, hasNoLocation: false,
  };
  const res = await fetch(`${API}/acts/${ACTOR}/runs`, { method: 'POST', headers: H(), body: JSON.stringify(input), signal: AbortSignal.timeout(60000) });
  const body = await res.text();
  if (!res.ok) {
    const e = new Error(`start run ${res.status}: ${body.slice(0, 240)}`);
    if (res.status === 402 || /monthly usage|usage.{0,10}limit|insufficient|credit|payment required|not enough|charged results|greater than zero|max-items/i.test(body)) e.creditExhausted = true;
    throw e;
  }
  return JSON.parse(body).data;
}

async function main() {
  if (!process.env.APIFY_TOKEN) { console.error('APIFY_TOKEN not set'); process.exit(1); }
  if (!process.env.DB_URL) { console.error('DB_URL not set'); process.exit(1); }

  let c = new Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
  c.on('error', () => {});
  await c.connect();
  async function query(sql, params) {
    let a = 0;
    while (true) {
      try { return await c.query(sql, params); }
      catch (e) { if (isTransient(e) && ++a < 6) { try { await c.end(); } catch {} await sleep(1000 * a); c = new Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } }); c.on('error', () => {}); await c.connect(); continue; } throw e; }
    }
  }

  const chunks = chunk(TITLE_SEARCH, CHUNK_SIZE);
  console.log(`Actor=${ACTOR} | ats=${ATS.length} sources | perChunkLimit=${LIMIT} | ${TITLE_SEARCH.length} titles in ${chunks.length} chunks (from #${CHUNK_START})\n`);

  const companyCache = new Map(); const seen = new Set(); const bySource = {};
  let total = 0, upserted = 0, companiesNew = 0, skipped = 0;
  const t0 = Date.now();

  async function ensureCompany(j, src) {
    if (companyCache.has(src.careerUrl)) return companyCache.get(src.careerUrl);
    let domain = src.host;
    try { if (j.organization_url) domain = new URL(j.organization_url).hostname; } catch {}
    const { rows } = await query(
      `INSERT INTO companies (career_url, domain, ats, ats_slug, company_name, logo_url, origin, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'apify-ats','active',NOW(),NOW())
       ON CONFLICT (career_url) DO UPDATE SET updated_at=NOW()
       RETURNING id, (xmax=0) AS inserted`,
      [src.careerUrl, truncBytes(domain, 250), src.ats, src.slug, truncBytes(j.organization || src.slug, 250), j.organization_logo || null]
    );
    if (rows[0].inserted) companiesNew++;
    companyCache.set(src.careerUrl, rows[0].id);
    return rows[0].id;
  }

  async function drainRun(run) {
    let offset = 0;
    while (true) {
      const batch = await apiGET(`/datasets/${run.defaultDatasetId}/items?offset=${offset}&limit=500&clean=true`);
      if (!Array.isArray(batch) || batch.length === 0) break;
      offset += batch.length; total += batch.length;
      const rows = [];
      for (const j of batch) {
        const src = parseSrc(j.url);
        if (!src || !src.slug) { skipped++; continue; }
        src.ats = (j.source || ATS[0] || 'bamboohr');
        bySource[src.ats] = (bySource[src.ats] || 0) + 1;
        const extId = `${src.ats}_${src.jobId || j.id}`;
        if (seen.has(extId)) continue;
        seen.add(extId);
        let companyId; try { companyId = await ensureCompany(j, src); } catch { skipped++; continue; }
        rows.push({ extId, companyId, ats: src.ats, j });
      }
      if (!rows.length) continue;
      const cols = 'external_id,company_id,ats,title,department,location,workplace_type,employment_type,salary_min,salary_max,salary_currency,salary_interval,description,url,posted_at,raw_data,visa_sponsorship,experience_level,is_remote,remote_worldwide,first_seen_at,last_seen_at';
      const vals = [];
      const tuples = rows.map((r, k) => {
        const b = k * 20; const j = r.j;
        vals.push(
          r.extId, r.companyId, r.ats, truncBytes(j.title || 'Untitled', 500),
          null, truncBytes(loc(j)), mapWorkplace(j.ai_work_arrangement),
          (Array.isArray(j.employment_type) ? j.employment_type[0] : j.employment_type) || j.ai_employment_type || null,
          j.ai_salary_min_value != null ? String(j.ai_salary_min_value) : null,
          j.ai_salary_max_value != null ? String(j.ai_salary_max_value) : null,
          j.ai_salary_currency || null, j.ai_salary_unit_text || null,
          j.description_text || null, j.url || null, j.date_posted || j.date_created || null, JSON.stringify(j),
          mapVisa(j.ai_visa_sponsorship), truncBytes(mapExp(j.ai_experience_level)),
          /remote/i.test(j.ai_work_arrangement || ''), false
        );
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14},$${b+15},$${b+16},$${b+17},$${b+18},$${b+19},$${b+20},NOW(),NOW())`;
      }).join(',');
      try {
        await query(
          `INSERT INTO jobs (${cols}) VALUES ${tuples}
           ON CONFLICT (external_id, company_id) DO UPDATE SET
             title=EXCLUDED.title, location=EXCLUDED.location, description=COALESCE(EXCLUDED.description, jobs.description),
             url=EXCLUDED.url, posted_at=EXCLUDED.posted_at, raw_data=EXCLUDED.raw_data,
             workplace_type=EXCLUDED.workplace_type, employment_type=EXCLUDED.employment_type,
             salary_min=EXCLUDED.salary_min, salary_max=EXCLUDED.salary_max, salary_currency=EXCLUDED.salary_currency, salary_interval=EXCLUDED.salary_interval,
             visa_sponsorship=CASE WHEN EXCLUDED.visa_sponsorship<>'' THEN EXCLUDED.visa_sponsorship ELSE jobs.visa_sponsorship END,
             experience_level=CASE WHEN EXCLUDED.experience_level<>'' THEN EXCLUDED.experience_level ELSE jobs.experience_level END,
             is_remote=EXCLUDED.is_remote, last_seen_at=NOW(), removed_at=NULL`,
          vals
        );
        upserted += rows.length;
      } catch (e) { console.error(`  upsert failed: ${e.message}`); }
    }
  }

  for (let ci = CHUNK_START; ci < chunks.length; ci++) {
    let run;
    try { run = await startRun(chunks[ci]); }
    catch (e) {
      if (e.creditExhausted) { console.log(`\n💳 Credit exhausted at chunk #${ci}/${chunks.length}. Stopping cleanly. (${e.message})`); break; }
      console.error(`chunk #${ci} start failed: ${e.message}`); continue;
    }
    let status = run.status, waited = 0;
    while (!['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(status) && waited < 600) {
      await sleep(5000); waited += 5;
      try { status = (await apiGET(`/actor-runs/${run.id}`)).data.status; } catch {}
    }
    if (status === 'SUCCEEDED') { try { await drainRun(run); } catch (e) { console.error(`chunk #${ci} drain failed: ${e.message}`); } }
    console.log(`chunk ${ci + 1}/${chunks.length} [${chunks[ci][0]} ...] | ${status} | jobs ${total} | upserted ${upserted} | newCos ${companiesNew} | ${(total / ((Date.now() - t0) / 1000)).toFixed(0)}/s`);
  }

  console.log(`\nDONE. jobsFetched=${total} | upserted=${upserted} | newCompanies=${companiesNew} | skipped=${skipped}`);
  console.log('by source:', JSON.stringify(Object.fromEntries(Object.entries(bySource).sort((a, b) => b[1] - a[1]))));
  await c.end();
}
main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
