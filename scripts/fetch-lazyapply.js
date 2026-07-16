#!/usr/bin/env node
/**
 * Fetches jobs from LazyApply API for company discovery.
 * Extracts new ATS company slugs and saves to local SQLite.
 *
 * Usage:
 *   node scripts/fetch-lazyapply.js --token=<JWT>
 *   node scripts/fetch-lazyapply.js --token=<JWT> --country=us --delay=2000
 *   node scripts/fetch-lazyapply.js --token=<JWT> --titles="Software Engineer,Data Scientist"
 */

const https = require('https');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'jobs.db');
const API_URL = 'https://backend.lazyapply.com/lazyapplyv2/job-search';

// --- CLI args ---
function getArg(name, fallback) {
  const match = process.argv.find(a => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : fallback;
}

const TOKEN = getArg('token', '');
const COUNTRY = getArg('country', 'us');
const DELAY_MS = parseInt(getArg('delay', '2000'));
const RESULTS_PER_PAGE = parseInt(getArg('results', '10'));
const MAX_PAGES = parseInt(getArg('maxPages', '5'));
const TOTAL_NEEDED = parseInt(getArg('totalNeeded', '50'));

if (!TOKEN) {
  console.error('Usage: node scripts/fetch-lazyapply.js --token=<JWT>');
  process.exit(1);
}

// --- Positions to search ---
// Comprehensive cross-industry role vocabulary (tech + 26 non-tech industries:
// supply chain, aerospace, healthcare, manufacturing, finance, legal, construction,
// energy, and more). Single source of truth shared by both fetchers.
const { ALL_ROLES: DEFAULT_TITLES } = require('./job-roles');

// --- ATS helpers ---
function parseAtsInfo(applyUrl, atsPlatform) {
  if (!applyUrl) return null;
  try {
    const url = new URL(applyUrl);
    const host = url.hostname.replace('www.', '');
    const pathParts = url.pathname.split('/').filter(Boolean);

    let ats = (atsPlatform || '').toLowerCase();
    let slug = null;
    let careerUrl = null;

    if (host.includes('greenhouse.io')) {
      ats = 'greenhouse';
      slug = pathParts[0] || null;
      if (slug) careerUrl = `https://boards.greenhouse.io/${slug}`;
    } else if (host.includes('lever.co')) {
      ats = 'lever';
      slug = pathParts[0] || null;
      if (slug) careerUrl = `https://jobs.lever.co/${slug}`;
    } else if (host.includes('ashbyhq.com')) {
      ats = 'ashby';
      slug = pathParts[0] || null;
      if (slug) careerUrl = `https://jobs.ashbyhq.com/${slug}`;
    } else if (host.includes('rippling.com')) {
      ats = 'rippling';
      slug = pathParts[0] || null;
      if (slug) careerUrl = `https://ats.rippling.com/${slug}`;
    } else if (host.includes('smartrecruiters.com')) {
      ats = 'smartrecruiters';
      slug = pathParts[0] || null;
      if (slug) careerUrl = `https://jobs.smartrecruiters.com/${slug}`;
    } else if (host.includes('workable.com')) {
      ats = 'workable';
      slug = pathParts[0] || null;
      if (slug) careerUrl = `https://apply.workable.com/${slug}`;
    } else if (host.includes('bamboohr.com')) {
      ats = 'bamboohr';
      slug = host.split('.')[0];
      if (slug && slug !== 'bamboohr') careerUrl = `https://${slug}.bamboohr.com/careers`;
    } else if (host.includes('recruitee.com')) {
      ats = 'recruitee';
      slug = host.split('.')[0];
      if (slug && slug !== 'recruitee') careerUrl = `https://${slug}.recruitee.com`;
    } else if (host.includes('breezy.hr')) {
      ats = 'breezy';
      slug = host.split('.')[0];
      if (slug && slug !== 'breezy') careerUrl = `https://${slug}.breezy.hr`;
    } else if (host.includes('personio.de') || host.includes('personio.com')) {
      ats = 'personio';
      slug = host.split('.')[0];
      if (slug && slug !== 'jobs') careerUrl = `https://${slug}.jobs.personio.de`;
    } else if (host.includes('pinpointhq.com')) {
      ats = 'pinpoint';
      slug = host.split('.')[0];
      if (slug && slug !== 'pinpoint') careerUrl = `https://${slug}.pinpointhq.com`;
    } else if (host.includes('jazzhr.com') || host.includes('applytojob.com')) {
      ats = 'jazzhr';
      slug = pathParts[0] || null;
      if (slug) careerUrl = `https://${slug}.applytojob.com`;
    } else if (host.includes('zohorecruit.com')) {
      ats = 'zoho';
      slug = host.split('.')[0];
      if (slug && slug !== 'zohorecruit') careerUrl = `https://${slug}.zohorecruit.com`;
    } else {
      // Unknown ATS - skip
      return null;
    }

    if (!slug || !ats) return null;

    return { ats, slug, careerUrl };
  } catch {
    return null;
  }
}

function cleanTitle(title) {
  // Remove "Job Application for ... at Company" pattern
  let clean = title
    .replace(/^Job Application for\s+/i, '')
    .replace(/\s+at\s+[\w\s.&'-]+$/i, '')
    .replace(/\s*-\s*(Greenhouse|Lever|Ashby|Rippling|Workable|SmartRecruiters)\s*$/i, '')
    .trim();
  return clean || title;
}

// --- HTTP helper ---
function post(url, body, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);

    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 401) {
          reject(new Error(`Auth failed (401) - token invalid or missing`));
          return;
        }
        if (res.statusCode === 403) {
          // 403 can mean token expiry OR LazyApply's upstream scraper (ScrapingDog)
          // hitting its account credit limit — a server-side quota, not our token.
          if (/account limit|scrapingdog|limit reached|quota/i.test(data)) {
            reject(new Error(`QUOTA: LazyApply upstream scraping quota reached (ScrapingDog account limit). The token is valid — this is a LazyApply plan/credit limit. Retry after it resets or upgrade the LazyApply plan. Raw: ${data.slice(0, 200)}`));
          } else {
            reject(new Error(`Auth failed (403) - token may be expired`));
          }
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message} | raw: ${data.slice(0, 200)}`)); }
      });
    });

    req.on('error', reject);
    req.on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Main ---
async function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  const customTitles = getArg('titles', null);
  const titles = customTitles ? customTitles.split(',').map(t => t.trim()) : DEFAULT_TITLES;

  // Prepared statements
  const findCompany = db.prepare('SELECT id FROM companies WHERE career_url = ?');

  const insertCompany = db.prepare(`
    INSERT INTO companies (company_name, domain, ats, ats_slug, career_url, logo_url, status, origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', 'lazyapply', datetime('now'), datetime('now'))
    ON CONFLICT(career_url) DO UPDATE SET
      company_name = COALESCE(EXCLUDED.company_name, companies.company_name),
      logo_url = COALESCE(EXCLUDED.logo_url, companies.logo_url),
      updated_at = datetime('now')
  `);

  const insertJob = db.prepare(`
    INSERT INTO jobs (external_id, company_id, ats, title, location, url, description,
      posted_at, raw_data, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(external_id, company_id) DO UPDATE SET
      title = EXCLUDED.title,
      url = EXCLUDED.url,
      last_seen_at = datetime('now')
  `);

  // Stats
  let totalApiJobs = 0;
  let newCompanies = 0;
  let newJobs = 0;
  let skipped = 0;
  let errors = 0;
  const seenJobIds = new Set();

  const existingBefore = db.prepare('SELECT COUNT(*) as c FROM companies').get().c;

  const processBatch = db.transaction((jobs) => {
    for (const job of jobs) {
      if (!job.apply_url || !job.jobId) { skipped++; continue; }

      const key = `${job.ats_platform}:${job.jobId}`;
      if (seenJobIds.has(key)) { skipped++; continue; }
      seenJobIds.add(key);

      const info = parseAtsInfo(job.apply_url, job.ats_platform);
      if (!info) { skipped++; continue; }

      // Check if company already existed
      const existed = findCompany.get(info.careerUrl);

      // Upsert company
      const domain = (() => {
        try { return new URL(info.careerUrl).hostname; } catch { return info.slug; }
      })();
      insertCompany.run(job.company || info.slug, domain, info.ats, info.slug, info.careerUrl, job.company_logo || job.logoUrl || null);

      if (!existed) newCompanies++;

      const companyRow = findCompany.get(info.careerUrl);
      if (!companyRow) continue;

      // Check if job is new
      const existingJob = db.prepare('SELECT 1 FROM jobs WHERE external_id = ? AND company_id = ?')
        .get(job.jobId, companyRow.id);

      insertJob.run(
        job.jobId,
        companyRow.id,
        info.ats,
        cleanTitle(job.title),
        job.location || null,
        job.apply_url,
        job.description || null,
        job.date_posted !== 'NA' ? job.date_posted : null,
        JSON.stringify({ source: 'lazyapply', rank: job.rank, jobBoard: job.jobBoard, logoUrl: job.company_logo || job.logoUrl || null }),
      );

      if (!existingJob) newJobs++;
    }
  });

  // Countries to cycle through for more coverage
  const COUNTRIES = [
    'us', 'uk', 'ca', 'au', 'de', 'fr', 'nl', 'in', 'sg', 'ie',
    'nz', 'se', 'no', 'dk', 'fi', 'ch', 'at', 'be', 'es', 'it',
    'br', 'mx', 'il', 'jp', 'kr', 'ae', 'za', 'ng', 'pl', 'pt'
  ];

  const TARGET_ATS = new Set(['greenhouse', 'lever', 'ashby', 'rippling']);
  // Early-stop cap on new target-ATS jobs. Override with --targetJobs=<n>;
  // pass a very large value (or --targetJobs=0) for an uncapped full crawl.
  const targetArg = parseInt(getArg('targetJobs', '20000'));
  const TARGET_JOBS = (!targetArg || targetArg <= 0) ? Infinity : targetArg;

  console.log(`LazyApply Fetcher — ${titles.length} titles × ${COUNTRIES.length} countries, delay=${DELAY_MS}ms`);
  console.log(`Target: ${TARGET_JOBS === Infinity ? 'uncapped' : TARGET_JOBS} new jobs from Lever/Greenhouse/Ashby/Rippling`);
  console.log(`DB before: ${existingBefore} companies\n`);

  const startTime = Date.now();
  let authFailed = false;

  for (const country of COUNTRIES) {
    if (authFailed || newJobs >= TARGET_JOBS) break;

    for (let ti = 0; ti < titles.length; ti++) {
      if (authFailed || newJobs >= TARGET_JOBS) break;

      const title = titles[ti];
      let pageJobs = 0;
      let page = 0;
      let hasMore = true;

      while (hasMore && page < MAX_PAGES) {
        try {
          const body = {
            titles: [title],
            locations: [],
            country,
            advanceSearch: false,
            totalNeeded: TOTAL_NEEDED,
            results: RESULTS_PER_PAGE,
            filtersForBackend: {
              jobType: '',
              experienceLevel: '',
              workType: '',
              timeFilter: 'qdr:m',
            },
            timeFilter: 'qdr:m',
            customTimeRange: null,
            startDate: null,
            endDate: null,
            language: 'en',
            safeSearch: 'off',
            searchType: 'web',
            page,
            maxPages: MAX_PAGES,
            enablePagination: true,
            companiesToExclude: [],
            includeGreenhouseJobs: true,
            includeWorkdayIcimsJobs: true,
            appliedToday: 0,
            dailyLimit: 0,
            searchSessionId: `fetch-${Date.now()}-${ti}-${country}-p${page}`,
          };

          const data = await post(API_URL, body, TOKEN);

          if (data.success && data.jobs?.length) {
            // Filter to only target ATS jobs before processing
            const targetJobs = data.jobs.filter(j => {
              const info = parseAtsInfo(j.apply_url, j.ats_platform);
              return info && TARGET_ATS.has(info.ats);
            });

            processBatch(data.jobs); // Still save all for company discovery
            totalApiJobs += data.jobs.length;
            pageJobs += targetJobs.length;

            // If we got fewer results than requested, no more pages
            if (data.jobs.length < RESULTS_PER_PAGE) hasMore = false;
            page++;
          } else {
            hasMore = false;
          }

          await sleep(DELAY_MS);

        } catch (err) {
          errors++;
          if (err.message.startsWith('QUOTA:')) {
            console.error(`\n${err.message}`);
            console.error('Stopping: every further request will fail until the quota resets.');
            authFailed = true; // reuse the stop flag to end the crawl cleanly
          } else if (err.message.includes('Auth failed')) {
            console.error('\nToken expired or invalid. Stopping.');
            authFailed = true;
          } else {
            console.error(`\n  ERROR on "${title}" (${country} p${page}): ${err.message}`);
          }
          hasMore = false;
          await sleep(5000);
        }
      }

      const totalCompanies = db.prepare('SELECT COUNT(*) as c FROM companies').get().c;
      const totalJobs = db.prepare('SELECT COUNT(*) as c FROM jobs').get().c;
      const targetJobCount = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE ats IN ('greenhouse','lever','ashby','rippling')").get().c;

      if (pageJobs > 0) {
        console.log(
          `[${country.toUpperCase()}] "${title}" → +${pageJobs} target ATS | ` +
          `new: +${newCompanies} co, +${newJobs} jobs | target ATS: ${targetJobCount} | DB: ${totalCompanies} co, ${totalJobs} jobs`
        );
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  const existingAfter = db.prepare('SELECT COUNT(*) as c FROM companies').get().c;
  const jobsAfter = db.prepare('SELECT COUNT(*) as c FROM jobs').get().c;

  console.log(`\n=== DONE ===`);
  console.log(`Time: ${elapsed} min`);
  console.log(`API jobs fetched: ${totalApiJobs}`);
  console.log(`New companies discovered: ${newCompanies}`);
  console.log(`New jobs saved: ${newJobs}`);
  console.log(`Skipped (dupes/unknown ATS): ${skipped}`);
  console.log(`Errors: ${errors}`);
  console.log(`DB totals: ${existingAfter} companies, ${jobsAfter} jobs`);

  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
