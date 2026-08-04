#!/usr/bin/env node
/**
 * Fetches jobs from Wonsulting's JobBoardAI (app.wonsulting.com) and saves to local SQLite.
 *
 * Discovery is keyword-driven via the shared scripts/job-roles.js vocabulary (tech +
 * 26 non-tech industries), same as the other fetchers. For each role it POSTs to the
 * /api/job-board/find-jobs catalog endpoint and paginates through the results
 * (each query caps at ~10,000 results server-side).
 *
 * Auth: Wonsulting is a Laravel SPA behind Cloudflare. You must pass a logged-in
 * browser session via --cookie (the full Cookie header, including `_cfuvid`,
 * `XSRF-TOKEN`, and `wonsulting_app_session_v2`). The CSRF header is derived from the
 * XSRF-TOKEN cookie automatically. Grab the Cookie header from DevTools → Network →
 * any app.wonsulting.com request. The session cookie is long-lived (~2 years), but
 * Cloudflare's `_cfuvid` and rate limits are shorter — re-grab if you start seeing 401s.
 *
 * Usage:
 *   node scripts/fetch-wonsulting.js --cookie="<full cookie header>"
 *   node scripts/fetch-wonsulting.js --cookie="..." --roles="Aerospace Engineer,Registered Nurse"
 *   node scripts/fetch-wonsulting.js --cookie="..." --allJobs        # include non-ATS aggregated jobs
 *   node scripts/fetch-wonsulting.js --cookie="..." --perPage=200 --delay=500 --maxPages=50
 */

const https = require('https');
const Database = require('better-sqlite3');
const path = require('path');
const { ALL_ROLES, ROLES_BY_INDUSTRY } = require('./job-roles');

// Non-tech-first ordering: all non-tech industries first (in catalog order), tech category
// last. Lets a crawl prioritize the non-tech verticals (healthcare, finance, legal, ...)
// before re-touching the already-well-covered tech roles.
function nonTechFirstRoles() {
  const techKey = Object.keys(ROLES_BY_INDUSTRY).find(k => /technology|software|data/i.test(k));
  const nonTech = [], tech = [];
  for (const [industry, roles] of Object.entries(ROLES_BY_INDUSTRY)) {
    (industry === techKey ? tech : nonTech).push(...roles);
  }
  return [...nonTech, ...tech];
}

// Never-crawled-first ordering. The first crawl run covered tech + the first 7 industries
// (Supply Chain..Finance). Catalog order is [tech, Supply Chain, Aerospace, Manufacturing,
// Mech/Elec/Civil, Healthcare, Biotech, Finance, Legal, ...Skilled Trades]. So put the
// never-crawled industries (Legal onward, indices 8+) FIRST for fresh content, then refresh
// the already-crawled non-tech (indices 1-7), then tech (index 0) last.
function neverCrawledFirstRoles() {
  const entries = Object.entries(ROLES_BY_INDUSTRY);
  const tech = entries[0];
  const doneRefresh = entries.slice(1, 8);
  const neverCrawled = entries.slice(8);
  const out = [];
  for (const [, roles] of [...neverCrawled, ...doneRefresh, tech]) out.push(...roles);
  return out;
}

const DB_PATH = path.join(__dirname, '..', 'data', 'jobs.db');
const HOST = 'app.wonsulting.com';
const FIND_PATH = '/api/job-board/find-jobs';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// --- CLI args ---
function getArg(name, fallback) {
  const m = process.argv.find(a => a.startsWith(`--${name}=`));
  return m ? m.split('=').slice(1).join('=') : fallback;
}
function hasFlag(name) { return process.argv.includes(`--${name}`); }

const COOKIE = getArg('cookie', process.env.WONSULTING_COOKIE || '');
const XSRF = decodeURIComponent((COOKIE.match(/XSRF-TOKEN=([^;]+)/) || [])[1] || getArg('xsrf', ''));
const PER_PAGE = parseInt(getArg('perPage', '100'));
const DELAY_MS = parseInt(getArg('delay', '600'));
const MAX_PAGES = parseInt(getArg('maxPages', '0')) || Infinity; // per-role page cap (0 = until exhausted/server cap)
const AUTO_APPLY = !hasFlag('allJobs'); // default: only auto-applyable ATS jobs
const SORT_BY = getArg('sortBy', 'posted_at');
const SORT_DIR = getArg('sortDir', 'desc');

if (!COOKIE || !XSRF) {
  console.error('Usage: node scripts/fetch-wonsulting.js --cookie="<full Cookie header including XSRF-TOKEN, wonsulting_app_session_v2, _cfuvid>"');
  console.error(XSRF ? '' : 'Could not find XSRF-TOKEN in the provided cookie.');
  process.exit(1);
}

// --- HTTP ---
function post(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: HOST, path: FIND_PATH, method: 'POST', timeout: 45000,
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'user-agent': UA,
        'x-xsrf-token': XSRF,
        'referer': `https://${HOST}/job-board/search`,
        'origin': `https://${HOST}`,
        'cookie': COOKIE,
        'content-length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function searchBody(role, page) {
  return {
    job_title: role, location: '', work_setting: null, last_posted: null,
    longitude: null, latitude: null, page, jobs_per_page: PER_PAGE,
    sort_by: SORT_BY, sort_direction: SORT_DIR, industry: null, radius: null,
    min_experience: null, max_experience: null, min_salary: null, max_salary: null,
    auto_apply_filter: AUTO_APPLY,
  };
}

// --- Mapping helpers ---
function stripTracking(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    ['userid', 'jobid', 'utm_source', 'utm_medium', 'utm_campaign'].forEach(p => u.searchParams.delete(p));
    return u.toString().replace(/\?$/, '');
  } catch { return url; }
}

// Derive a canonical company career_url + ats slug. Mirrors the career_url formats used
// by fetch-lazyapply.js so Wonsulting jobs on shared ATS boards merge with existing rows.
function deriveCompany(applyUrl, atsName, companyName) {
  const clean = stripTracking(applyUrl);
  let host = '', parts = [], proto = 'https:';
  try { const u = new URL(clean); host = u.hostname.replace(/^www\./, ''); parts = u.pathname.split('/').filter(Boolean); proto = u.protocol; } catch {}
  const sub = host.split('.')[0];
  let ats = (atsName || '').toLowerCase(), slug = null, careerUrl = null;

  if (host.includes('greenhouse.io')) { ats = 'greenhouse'; slug = parts[0] || null; if (slug) careerUrl = `https://boards.greenhouse.io/${slug}`; }
  else if (host.includes('lever.co')) { ats = 'lever'; slug = parts[0] || null; if (slug) careerUrl = `https://jobs.lever.co/${slug}`; }
  else if (host.includes('ashbyhq.com')) { ats = 'ashby'; slug = parts[0] || null; if (slug) careerUrl = `https://jobs.ashbyhq.com/${slug}`; }
  else if (host.includes('rippling.com')) { ats = 'rippling'; slug = parts[0] || null; if (slug) careerUrl = `https://ats.rippling.com/${slug}`; }
  else if (host.includes('smartrecruiters.com')) { ats = 'smartrecruiters'; slug = parts[0] || null; if (slug) careerUrl = `https://jobs.smartrecruiters.com/${slug}`; }
  else if (host.includes('workable.com')) { ats = 'workable'; slug = parts[0] || null; if (slug) careerUrl = `https://apply.workable.com/${slug}`; }
  else if (host.includes('bamboohr.com')) { ats = 'bamboohr'; slug = sub !== 'bamboohr' ? sub : null; if (slug) careerUrl = `https://${slug}.bamboohr.com/careers`; }
  else if (host.includes('recruitee.com')) { ats = 'recruitee'; slug = sub !== 'recruitee' ? sub : null; if (slug) careerUrl = `https://${slug}.recruitee.com`; }
  else if (host.includes('breezy.hr')) { ats = 'breezy'; slug = sub !== 'breezy' ? sub : null; if (slug) careerUrl = `https://${slug}.breezy.hr`; }
  else if (host.includes('jazzhr.com') || host.includes('applytojob.com')) { ats = 'jazzhr'; slug = parts[0] || sub; if (slug) careerUrl = `https://${slug}.applytojob.com`; }
  else if (host.includes('zohorecruit.com')) { ats = 'zoho'; slug = sub !== 'zohorecruit' ? sub : null; if (slug) careerUrl = `https://${slug}.zohorecruit.com`; }
  else if (host.includes('careers-page.com')) { ats = ats || 'manatal'; slug = parts[0] || null; if (slug) careerUrl = `https://www.careers-page.com/${slug}`; }
  else if (host.includes('myworkdayjobs.com')) { ats = 'workday'; const m = clean.match(/\/\/([^.]+)\.(wd\d+)\.myworkdayjobs\.com/i); if (m) { slug = m[1]; careerUrl = `https://${m[1]}.${m[2]}.myworkdayjobs.com`; } }
  else if (host.includes('icims.com')) { ats = 'icims'; slug = sub.replace(/^careers-/, ''); if (slug && slug !== 'icims') careerUrl = `https://${slug}.icims.com`; else slug = null; }
  else if (host.includes('paylocity.com')) { ats = 'paylocity'; const g = clean.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || clean.match(/\/(?:All|Details)\/(\d+)/i); slug = g ? (g[1] || g[0]) : null; if (slug) careerUrl = `https://recruiting.paylocity.com/recruiting/jobs/All/${slug}`; }
  else if (host.includes('pinpointhq.com')) { ats = 'pinpoint'; slug = sub !== 'pinpointhq' ? sub : null; if (slug) careerUrl = `https://${slug}.pinpointhq.com`; }
  else if (host.includes('teamtailor.com')) { ats = 'teamtailor'; slug = sub !== 'teamtailor' ? sub : null; if (slug) careerUrl = `https://${slug}.teamtailor.com`; }
  else if (host.includes('personio.')) { ats = 'personio'; slug = sub; if (slug) careerUrl = `https://${slug}.jobs.personio.com`; }
  else if (host.includes('successfactors.')) { ats = 'successfactors'; slug = (clean.match(/career([^/.]+)\.successfactors/i) || [])[1]; if (slug) careerUrl = `https://career${slug}.successfactors.eu`; }

  // Generic fallback: scheme://host/<first-path-segment>, else namespace by company name.
  if (!careerUrl) {
    if (host && parts[0]) { slug = parts[0]; careerUrl = `${proto}//${host}/${slug}`; }
    else if (host) { slug = sub; careerUrl = `${proto}//${host}`; }
    else { slug = (companyName || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); careerUrl = `wonsulting://${slug}`; }
  }
  const domain = host || 'wonsulting.com';
  return { ats: ats || 'wonsulting', slug, careerUrl, domain };
}

function mapWorkplace(workSetting, isRemote) {
  const w = (workSetting || '').toLowerCase();
  if (isRemote === true || w === 'remote') return 'remote';
  if (w === 'hybrid') return 'hybrid';
  if (w === 'in-person' || w === 'on-site' || w === 'onsite') return 'onsite';
  return null;
}

// --- Main ---
function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  const insertCompany = db.prepare(`
    INSERT INTO companies (company_name, domain, ats, ats_slug, career_url, logo_url, status, origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', 'wonsulting', datetime('now'), datetime('now'))
    ON CONFLICT(career_url) DO UPDATE SET
      company_name = COALESCE(EXCLUDED.company_name, companies.company_name),
      updated_at = datetime('now')
  `);
  const getCompany = db.prepare('SELECT id FROM companies WHERE career_url = ?');
  const jobExists = db.prepare('SELECT 1 FROM jobs WHERE external_id = ? AND company_id = ?');
  const insertJob = db.prepare(`
    INSERT INTO jobs (external_id, company_id, ats, title, department, location, workplace_type,
      employment_type, description, url, posted_at, is_remote,
      salary_min, salary_max, salary_currency, salary_interval, raw_data,
      first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(external_id, company_id) DO UPDATE SET
      title = EXCLUDED.title,
      location = EXCLUDED.location,
      workplace_type = EXCLUDED.workplace_type,
      description = COALESCE(EXCLUDED.description, jobs.description),
      url = EXCLUDED.url,
      last_seen_at = datetime('now')
  `);

  const seen = new Set();
  let totalFetched = 0, totalNewJobs = 0, totalNewCompanies = 0, totalSkipped = 0;

  function processJob(job) {
    const pid = job.provider_job_id;
    if (!pid || seen.has(pid)) { totalSkipped++; return; }
    seen.add(pid);
    if (!job.apply_url || !job.company) { totalSkipped++; return; }

    const atsName = job.ats_platform && typeof job.ats_platform === 'object' ? job.ats_platform.name : (typeof job.ats_platform === 'string' ? job.ats_platform : null);
    const c = deriveCompany(job.apply_url, atsName, job.company);

    const existed = getCompany.get(c.careerUrl);
    insertCompany.run(job.company, c.domain, c.ats, c.slug, c.careerUrl, null);
    if (!existed) totalNewCompanies++;
    const row = getCompany.get(c.careerUrl);
    if (!row) return;

    const isNew = !jobExists.get(String(pid), row.id);
    const ats = job.ats_platform && typeof job.ats_platform === 'object' ? (job.ats_platform.display_name || job.ats_platform.name) : c.ats;

    insertJob.run(
      String(pid),
      row.id,
      c.ats,
      job.job_title || 'Unknown',
      job.category || null,
      job.location || null,
      mapWorkplace(job.work_setting, job.is_remote),
      job.job_type || null,
      job.description || null,
      stripTracking(job.apply_url),
      job.posted_at || null,
      mapWorkplace(job.work_setting, job.is_remote) === 'remote' ? 1 : 0,
      Number.isFinite(job.min_salary) ? job.min_salary : null,
      Number.isFinite(job.max_salary) ? job.max_salary : null,
      null,
      null,
      JSON.stringify({
        source: 'wonsulting', ats_display: ats, ats_job_identifier: job.ats_job_identifier,
        discipline_id: job.discipline_id, category: job.category, work_setting: job.work_setting,
        formatted_min_salary: job.formatted_min_salary, formatted_max_salary: job.formatted_max_salary,
        min_experience: job.min_experience, max_experience: job.max_experience,
        is_salary_estimated: job.is_salary_estimated, is_auto_apply_supported: job.is_auto_apply_supported,
      }),
    );
    if (isNew) totalNewJobs++;
  }

  const processBatch = db.transaction((jobs) => { for (const j of jobs) processJob(j); });

  async function fetchRole(role) {
    let page = 1, pagesTotal = 1, roleNew = 0, consecFails = 0;
    while (page <= pagesTotal && page <= MAX_PAGES) {
      let attempt = 0, data = null;
      while (attempt < 5) {
        attempt++;
        try {
          const res = await post(searchBody(role, page));
          if (res.status === 429) {
            const wait = parseInt(res.headers['retry-after']) * 1000 || 30000;
            process.stdout.write(`\n  rate-limited, sleeping ${Math.round(wait / 1000)}s...`);
            await sleep(wait);
            attempt--; // don't count rate-limit waits against the retry budget
            continue;
          }
          if (res.status === 401 || res.status === 419) throw new Error(`AUTH (${res.status}) - cookie/CSRF invalid or expired. Re-grab the Cookie header from the browser.`);
          if (res.status === 422) { data = { jobs: [], pages_total: 0 }; break; } // invalid query for this role, skip
          if (res.status !== 200) { process.stdout.write(`\n  HTTP ${res.status} on "${role}" p${page}, retry ${attempt}/5`); await sleep(2000 * attempt); continue; }
          data = JSON.parse(res.body);
          break;
        } catch (err) {
          if (err.message.startsWith('AUTH')) throw err;
          process.stdout.write(`\n  err "${role}" p${page}: ${err.message}, retry ${attempt}/5`);
          await sleep(2000 * attempt);
        }
      }

      if (!data) {
        // Page failed after all retries (usually a transient server 500). Skip just this
        // page and keep going; bail on the role only after several consecutive failures.
        if (++consecFails >= 3) { process.stdout.write(`\n  giving up on "${role}" after ${consecFails} consecutive page failures (last p${page})`); break; }
        page++;
        if (page <= pagesTotal && page <= MAX_PAGES) await sleep(DELAY_MS);
        continue;
      }
      consecFails = 0;

      const jobs = data.jobs || [];
      pagesTotal = data.pages_total || 0;
      if (jobs.length === 0) break;

      const before = totalNewJobs;
      processBatch(jobs);
      roleNew += totalNewJobs - before;
      totalFetched += jobs.length;

      const dbJobs = db.prepare('SELECT COUNT(*) c FROM jobs').get().c;
      const dbCos = db.prepare('SELECT COUNT(*) c FROM companies').get().c;
      process.stdout.write(
        `\r[${role}] p${page}/${pagesTotal} | batch ${jobs.length} | count ${data.jobs_count} | ` +
        `new: +${totalNewJobs} jobs, +${totalNewCompanies} co | DB: ${dbJobs} jobs, ${dbCos} co | fetched ${totalFetched} | dupes ${totalSkipped}`
      );

      page++;
      if (page <= pagesTotal && page <= MAX_PAGES) await sleep(DELAY_MS);
    }
    return roleNew;
  }

  async function run() {
    const customRoles = getArg('roles', null);
    const order = hasFlag('newIndustriesFirst') ? 'never-crawled first'
      : hasFlag('nonTechFirst') ? 'non-tech first' : 'default';
    const roles = customRoles
      ? customRoles.split(',').map(r => r.trim()).filter(Boolean)
      : hasFlag('newIndustriesFirst') ? neverCrawledFirstRoles()
      : hasFlag('nonTechFirst') ? nonTechFirstRoles()
      : ALL_ROLES;

    console.log(`Wonsulting Fetcher — ${roles.length} roles (${order}) | perPage=${PER_PAGE} | delay=${DELAY_MS}ms | auto_apply_filter=${AUTO_APPLY}${MAX_PAGES !== Infinity ? ` | maxPages=${MAX_PAGES}` : ''}`);
    console.log(`Each query caps at ~10,000 server-side results.\n`);
    const start = Date.now();

    try {
      for (const role of roles) {
        await fetchRole(role);
        process.stdout.write('\n');
      }
    } catch (err) {
      console.error(`\n\nStopped: ${err.message}`);
    }

    const mins = ((Date.now() - start) / 60000).toFixed(1);
    const finalJobs = db.prepare('SELECT COUNT(*) c FROM jobs').get().c;
    const finalCos = db.prepare('SELECT COUNT(*) c FROM companies').get().c;
    const wonsCos = db.prepare("SELECT COUNT(*) c FROM companies WHERE origin='wonsulting'").get().c;
    console.log(`\n=== DONE ===`);
    console.log(`Time: ${mins} min`);
    console.log(`API results fetched: ${totalFetched}`);
    console.log(`Duplicates skipped: ${totalSkipped}`);
    console.log(`New jobs: ${totalNewJobs} | New companies: ${totalNewCompanies}`);
    console.log(`DB totals: ${finalJobs} jobs, ${finalCos} companies (${wonsCos} from wonsulting)`);
    db.close();
  }

  run().catch(err => { console.error(err); process.exit(1); });
}

main();
