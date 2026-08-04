#!/usr/bin/env node
/**
 * Fetches jobs from LiftMyCV public API and saves to local SQLite.
 * Usage: node scripts/fetch-liftmycv.js [--roles "role1,role2"] [--locations "loc1,loc2"] [--delay 2000]
 *
 * Saves companies and jobs to local SQLite DB (data/jobs.db) for later sync to Postgres.
 */

const https = require('https');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'jobs.db');

// Comprehensive cross-industry role vocabulary (tech + 26 non-tech industries:
// supply chain, aerospace, healthcare, manufacturing, finance, legal, construction,
// energy, and more). Single source of truth shared by both fetchers.
const { ALL_ROLES: DEFAULT_ROLES } = require('./job-roles');

const DEFAULT_LOCATIONS = [
  'United States', 'United Kingdom', 'Canada', 'Germany', 'Remote',
  'Netherlands', 'France', 'Australia', 'Ireland', 'Singapore',
  'India', 'Spain', 'Sweden', 'Switzerland', 'Japan',
];

const PAGE_SIZE = 500;
const DELAY_MS = parseInt(process.argv.find(a => a.startsWith('--delay='))?.split('=')[1] || '1500');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function mapPlatformToAts(platform) {
  const map = {
    greenhouse: 'greenhouse',
    lever: 'lever',
    ashby: 'ashby',
    workable: 'workable',
    bamboohr: 'bamboohr',
    smartrecruiters: 'smartrecruiters',
    recruitee: 'recruitee',
    breezy: 'breezy',
    personio: 'personio',
    pinpoint: 'pinpoint',
    jazzhr: 'jazzhr',
    rippling: 'rippling',
    zoho: 'zoho',
  };
  return map[platform?.toLowerCase()] || platform?.toLowerCase() || 'unknown';
}

function extractSlugFromUrl(companyUrl, platform) {
  if (!companyUrl) return null;
  try {
    const url = new URL(companyUrl);
    const host = url.hostname.toLowerCase();
    // Subdomain-based ATS: the tenant lives in the hostname, NOT a path segment.
    // Guard these BEFORE the path-based default, otherwise the URL's locale/path
    // segment (e.g. "en-US") gets stored as the slug and every sync fails.
    // Workday: {tenant}.wd{N}.myworkdayjobs.com/{locale}/{site}  -> "fox"
    if (host.endsWith('.myworkdayjobs.com')) return host.split('.')[0] || null;
    // iCIMS: {slug}.icims.com  (e.g. careers-vhchealth.icims.com) -> "careers-vhchealth"
    if (host.endsWith('.icims.com')) return host.split('.')[0] || null;
    // Path-based ATS (greenhouse/lever/ashby and the default): first path segment.
    const parts = url.pathname.split('/').filter(Boolean);
    return parts[0] || null;
  } catch { return null; }
}

function extractWorkplaceType(job) {
  const wt = job.workplaceType?.toUpperCase();
  if (wt === 'REMOTE') return 'remote';
  if (wt === 'HYBRID') return 'hybrid';
  if (wt === 'ONSITE' || wt === 'ON_SITE') return 'onsite';
  return null;
}

function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Prepare statements
  const insertCompany = db.prepare(`
    INSERT INTO companies (company_name, domain, ats, ats_slug, career_url, status, origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', 'liftmycv', datetime('now'), datetime('now'))
    ON CONFLICT(career_url) DO UPDATE SET
      company_name = COALESCE(EXCLUDED.company_name, companies.company_name),
      logo_url = COALESCE(EXCLUDED.logo_url, companies.logo_url),
      updated_at = datetime('now')
  `);

  const getCompany = db.prepare('SELECT id FROM companies WHERE career_url = ?');

  const insertJob = db.prepare(`
    INSERT INTO jobs (external_id, company_id, ats, title, department, location, workplace_type,
      employment_type, description, url, posted_at, is_remote, raw_data,
      first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(external_id, company_id) DO UPDATE SET
      title = EXCLUDED.title,
      location = EXCLUDED.location,
      workplace_type = EXCLUDED.workplace_type,
      description = COALESCE(EXCLUDED.description, jobs.description),
      url = EXCLUDED.url,
      last_seen_at = datetime('now')
  `);

  const seenIds = new Set();
  let totalFetched = 0;
  let totalNewJobs = 0;
  let totalNewCompanies = 0;
  let totalSkipped = 0;

  function processJob(job) {
    if (!job.id || seenIds.has(job.id)) { totalSkipped++; return; }
    seenIds.add(job.id);

    const ats = mapPlatformToAts(job.platform);
    const slug = extractSlugFromUrl(job.companyUrl, job.platform);
    if (!slug || !job.company) return;

    const careerUrl = job.companyUrl?.replace(/\/$/, '') || `https://unknown/${slug}`;
    const domain = (() => {
      try { return new URL(careerUrl).hostname; } catch { return slug; }
    })();

    // Upsert company
    insertCompany.run(job.company, domain, ats, slug, careerUrl);
    const row = getCompany.get(careerUrl);
    if (!row) return;

    const isNew = db.prepare('SELECT 1 FROM jobs WHERE external_id = ? AND company_id = ?').get(job.id, row.id);

    const postedAt = job.jobCreatedAt ? new Date(job.jobCreatedAt * 1000).toISOString() : null;
    const isRemote = extractWorkplaceType(job) === 'remote' ? 1 : 0;

    insertJob.run(
      job.id,
      row.id,
      ats,
      job.role,
      null, // department
      job.location,
      extractWorkplaceType(job),
      null, // employment_type
      job.description || job.formattedDescription || null,
      job.jobUrl,
      postedAt,
      isRemote,
      JSON.stringify({ platform: job.platform, salary: job.salary, logoUrl: job.logoUrl, summary: job.summary }),
    );

    if (!isNew) totalNewJobs++;
  }

  const processBatch = db.transaction((jobs) => {
    for (const job of jobs) {
      processJob(job);
    }
  });

  async function fetchRole(role, location) {
    let page = 1;
    let totalForQuery = 0;

    while (true) {
      const params = new URLSearchParams({
        roles: role,
        count: PAGE_SIZE,
        page,
      });
      if (location) params.set('location', location);

      const url = `https://app.liftmycv.com/api/v1/jobs/search?${params}`;

      try {
        const data = await fetch(url);
        const jobs = data.results?.jobs || [];
        const total = data.results?.total || 0;

        if (jobs.length === 0) break;

        processBatch(jobs);
        totalFetched += jobs.length;
        totalForQuery += jobs.length;

        const companiesSoFar = db.prepare('SELECT COUNT(*) as c FROM companies').get().c;
        const jobsSoFar = db.prepare('SELECT COUNT(*) as c FROM jobs').get().c;

        process.stdout.write(
          `\r[${role}] ${location || 'Global'} p${page} | batch: ${jobs.length} | query total: ${total} | ` +
          `DB: ${jobsSoFar} jobs, ${companiesSoFar} companies | fetched: ${totalFetched} | skipped dupes: ${totalSkipped}`
        );

        if (totalForQuery >= total || jobs.length < PAGE_SIZE) break;
        page++;
        await sleep(DELAY_MS);
      } catch (err) {
        console.error(`\nError fetching ${role} p${page}: ${err.message}`);
        await sleep(5000);
        break;
      }
    }
  }

  async function run() {
    const customRoles = process.argv.find(a => a.startsWith('--roles='))?.split('=').slice(1).join('=').split(',');
    const customLocations = process.argv.find(a => a.startsWith('--locations='))?.split('=').slice(1).join('=').split(',');

    const roles = customRoles || DEFAULT_ROLES;
    const locations = customLocations || DEFAULT_LOCATIONS;

    console.log(`Starting LiftMyCV fetch: ${roles.length} roles × ${locations.length} locations = ${roles.length * locations.length} queries`);
    console.log(`Delay between requests: ${DELAY_MS}ms\n`);

    const startTime = Date.now();

    for (const role of roles) {
      for (const location of locations) {
        await fetchRole(role, location);
        process.stdout.write('\n');
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    const finalJobs = db.prepare('SELECT COUNT(*) as c FROM jobs').get().c;
    const finalCompanies = db.prepare('SELECT COUNT(*) as c FROM companies').get().c;

    console.log(`\n\n=== DONE ===`);
    console.log(`Time: ${elapsed} minutes`);
    console.log(`Total API results fetched: ${totalFetched}`);
    console.log(`Duplicates skipped: ${totalSkipped}`);
    console.log(`Unique jobs in DB: ${finalJobs}`);
    console.log(`Unique companies in DB: ${finalCompanies}`);

    db.close();
  }

  run().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { extractSlugFromUrl, mapPlatformToAts };

if (require.main === module) main();
