#!/usr/bin/env node
/**
 * Pull jobs from the jobo.world "ATS Jobs API" Apify actor (NDli5o5pYKW1atJAY)
 * for every role in scripts/job-roles.js ALL_ROLES, filtered to one ATS source,
 * and upsert them directly into Heroku Postgres (origin='apify-ats').
 *
 * BILLED PER JOB RETURNED (~$0.004/job). A BUDGET_USD cap bounds spend: the run
 * stops once cumulative returned jobs would exceed the cap.
 *
 *   APIFY_TOKEN=... DB_URL=$(heroku config:get DATABASE_URL -a fastapply-board) \
 *   BUDGET_USD=25 SOURCE=bamboohr node scripts/fetch-apify-ats.js
 *
 * Env: APIFY_TOKEN, DB_URL (required); BUDGET_USD (25), SOURCE (bamboohr),
 *      PAGE_SIZE (100), SEARCH_DESC (0), ROLE_START (0 — resume offset).
 */
const { Client } = require('pg');
const { ALL_ROLES } = require('./job-roles.js');

const ACTOR = 'NDli5o5pYKW1atJAY';
const SOURCE = process.env.SOURCE || 'bamboohr';
const BUDGET_USD = parseFloat(process.env.BUDGET_USD || '25');
const COST_PER_JOB = 0.004;
const COST_CAP_JOBS = Math.floor(BUDGET_USD / COST_PER_JOB);
const PAGE_SIZE = parseInt(process.env.PAGE_SIZE || '100', 10);
const SEARCH_DESC = process.env.SEARCH_DESC === '1';
const ROLE_START = parseInt(process.env.ROLE_START || '0', 10);
// QUERIES: '|'-separated custom queries (overrides ALL_ROLES). LOCATIONS: '|'-separated.
const QUERIES = process.env.QUERIES ? process.env.QUERIES.split('|').map(s => s.trim()).filter(Boolean) : ALL_ROLES;
const LOCATIONS = process.env.LOCATIONS ? process.env.LOCATIONS.split('|').map(s => s.trim()).filter(Boolean) : [];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TRANSIENT = /EADDRNOTAVAIL|ECONNRESET|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network|not queryable|connection|terminat|timeout|50\d/i;
const isTransient = (e) => !!e && (e.name === 'TimeoutError' || TRANSIENT.test(e.message || '') || TRANSIENT.test(e.cause?.code || ''));

function truncBytes(s, max = 2600) {
  if (s == null) return s;
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  return Buffer.from(s, 'utf8').subarray(0, max).toString('utf8').replace(/�+$/, '');
}

function mapExp(s) {
  if (!s) return null;
  const t = s.toLowerCase();
  if (t.includes('intern')) return 'internship';
  if (t.includes('entry') || t.includes('junior')) return 'entry';
  if (t.includes('mid')) return 'mid';
  if (t.includes('senior') || t.includes('staff') || t.includes('principal')) return 'senior';
  if (t.includes('lead') || t.includes('manager')) return 'lead';
  if (t.includes('exec') || t.includes('director') || t.includes('chief') || /\bvp\b/.test(t)) return 'executive';
  return null;
}
function mapWorkplace(s) {
  if (!s) return null;
  const t = s.toLowerCase();
  if (t.includes('remote')) return 'remote';
  if (t.includes('hybrid')) return 'hybrid';
  if (t.includes('on')) return 'onsite';
  return null;
}
// bamboohr listing_url: https://{slug}.bamboohr.com/careers/{jobId}
function parseSource(url) {
  try {
    const u = new URL(url);
    const slug = u.hostname.split('.')[0];
    const jobId = u.pathname.split('/').filter(Boolean).pop();
    return { slug, host: u.hostname, jobId };
  } catch { return null; }
}
function jobLocation(item) {
  const locs = item.locations || [];
  if (locs.length && locs[0].location) return locs.map(l => l.location).filter(Boolean).join('; ');
  return null;
}

async function callActor(role, attempt = 0) {
  try {
    const res = await fetch(`https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.APIFY_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries: [role], search_description: SEARCH_DESC, sources: [SOURCE], ...(LOCATIONS.length ? { locations: LOCATIONS } : {}), page: 1, page_size: PAGE_SIZE, include_company_details: false }),
      signal: AbortSignal.timeout(180000),
    });
    if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`Apify HTTP ${res.status}`), { retryable: true });
    if (!res.ok) {
      const body = await res.text();
      const e = new Error(`Apify HTTP ${res.status}: ${body.slice(0, 200)}`);
      // Credit/usage exhaustion — stop the whole run, don't retry.
      if (res.status === 402 || /monthly usage|usage.{0,10}limit|insufficient|credit|payment required|quota|not enough/i.test(body)) e.creditExhausted = true;
      throw e;
    }
    const items = await res.json();
    return Array.isArray(items) ? items : [];
  } catch (err) {
    if ((err.retryable || isTransient(err)) && attempt < 5) { await sleep(Math.min(30000, 1000 * 2 ** attempt)); return callActor(role, attempt + 1); }
    throw err;
  }
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
      catch (e) {
        if (isTransient(e) && ++a < 6) { try { await c.end(); } catch {} await sleep(1000 * a); c = new Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } }); c.on('error', () => {}); await c.connect(); continue; }
        throw e;
      }
    }
  }

  console.log(`Source=${SOURCE} | budget $${BUDGET_USD} (~${COST_CAP_JOBS.toLocaleString()} jobs) | roles=${QUERIES.length} from #${ROLE_START} | pageSize=${PAGE_SIZE}\n`);

  const companyCache = new Map(); // career_url -> companyId
  const seenJob = new Set();       // external_id de-dupe within this run
  let returned = 0, inserted = 0, companiesNew = 0, rolesDone = 0, empty = 0;
  const t0 = Date.now();

  async function ensureCompany(company, slug, host) {
    const careerUrl = `https://${host}/careers`;
    if (companyCache.has(careerUrl)) return companyCache.get(careerUrl);
    let domain = host;
    try { if (company?.website) domain = new URL(company.website).hostname; } catch {}
    const { rows } = await query(
      `INSERT INTO companies (career_url, domain, ats, ats_slug, company_name, logo_url, origin, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'apify-ats','active',NOW(),NOW())
       ON CONFLICT (career_url) DO UPDATE SET updated_at=NOW()
       RETURNING id, (xmax=0) AS inserted`,
      [careerUrl, truncBytes(domain, 250), SOURCE, slug, truncBytes(company?.name || slug, 250), company?.logo_url || null]
    );
    if (rows[0].inserted) companiesNew++;
    companyCache.set(careerUrl, rows[0].id);
    return rows[0].id;
  }

  for (let i = ROLE_START; i < QUERIES.length; i++) {
    if (returned >= COST_CAP_JOBS) { console.log(`\nBudget cap reached (${returned} jobs returned).`); break; }
    const role = QUERIES[i];
    let items;
    try { items = await callActor(role); }
    catch (e) {
      if (e.creditExhausted) { console.log(`\n💳 Free credit exhausted — stopping cleanly at role #${i}. (${e.message})`); break; }
      console.error(`  role "${role}" failed: ${e.message}`); continue;
    }
    returned += items.length;
    rolesDone++;
    if (items.length === 0) empty++;

    // Resolve companies, then upsert each job.
    const rows = [];
    for (const it of items) {
      const src = parseSource(it.listing_url || it.apply_url);
      if (!src || !src.jobId) continue;
      const extId = `${SOURCE}_${src.jobId}`;
      const key = `${extId}`;
      if (seenJob.has(key)) continue;
      seenJob.add(key);
      let companyId;
      try { companyId = await ensureCompany(it.company, src.slug, src.host); }
      catch (e) { continue; }
      rows.push({ extId, companyId, it, src });
    }
    if (rows.length) {
      const cols = 'external_id,company_id,ats,title,department,location,workplace_type,employment_type,salary_min,salary_max,salary_currency,salary_interval,description,url,posted_at,raw_data,visa_sponsorship,experience_level,is_remote,remote_worldwide,first_seen_at,last_seen_at';
      const vals = [];
      const tuples = rows.map((r, k) => {
        const b = k * 20;
        const it = r.it, comp = it.compensation || {};
        vals.push(
          r.extId, r.companyId, SOURCE, truncBytes(it.title || 'Untitled', 500),
          it.department || null, truncBytes(jobLocation(it)), mapWorkplace(it.workplace_type),
          it.employment_type || null, comp.min != null ? String(comp.min) : null, comp.max != null ? String(comp.max) : null,
          comp.currency || null, comp.period || null, it.description || it.summary || null,
          it.listing_url || it.apply_url || null, it.date_posted || it.created_at || null, JSON.stringify(it),
          '', truncBytes(mapExp(it.experience_level)), (it.workplace_type || '').toLowerCase().includes('remote'), false
        );
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14},$${b+15},$${b+16},$${b+17},$${b+18},$${b+19},$${b+20},NOW(),NOW())`;
      }).join(',');
      try {
        await query(
          `INSERT INTO jobs (${cols}) VALUES ${tuples}
           ON CONFLICT (external_id, company_id) DO UPDATE SET
             title=EXCLUDED.title, location=EXCLUDED.location, description=COALESCE(EXCLUDED.description, jobs.description),
             url=EXCLUDED.url, posted_at=EXCLUDED.posted_at, raw_data=EXCLUDED.raw_data,
             experience_level=CASE WHEN EXCLUDED.experience_level<>'' THEN EXCLUDED.experience_level ELSE jobs.experience_level END,
             workplace_type=EXCLUDED.workplace_type, employment_type=EXCLUDED.employment_type,
             salary_min=EXCLUDED.salary_min, salary_max=EXCLUDED.salary_max, salary_currency=EXCLUDED.salary_currency,
             last_seen_at=NOW(), removed_at=NULL`,
          vals
        );
        inserted += rows.length;
      } catch (e) { console.error(`  insert failed for role "${role}": ${e.message}`); }
    }

    if (rolesDone % 10 === 0) {
      const el = (Date.now() - t0) / 1000;
      console.log(`role ${i}/${QUERIES.length} "${role}" | returned ${returned} (~$${(returned*COST_PER_JOB).toFixed(2)}) | upserted ${inserted} | companies +${companiesNew} | empty ${empty} | ${(returned/el).toFixed(0)} jobs/s`);
    }
  }

  console.log(`\nDONE. rolesProcessed=${rolesDone} | jobsReturned=${returned} (~$${(returned*COST_PER_JOB).toFixed(2)}) | jobsUpserted=${inserted} | newCompanies=${companiesNew} | emptyRoles=${empty}`);
  await c.end();
}
main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
