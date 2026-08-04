/**
 * Paylocity jobs from the AllSCM (jobboardly) feed.
 *
 * The allscm feed lists Paylocity jobs as per-JOB apply URLs:
 *   https://recruiting.paylocity.com/Recruiting/Jobs/Apply/{jobId}
 * — which carry no company id, so the original scrape-allscm.js (which keys
 * companies off an ATS slug) silently skipped all of them. And the paylocity
 * ADAPTER's feed API returns empty for every GUID/number we can find, so the
 * normal company->adapter path yields nothing either.
 *
 * This module recovers those jobs directly:
 *   1. Parse the paylocity <job> blocks straight from the feed (title, location,
 *      arrangement, location_type — all present in the feed).
 *   2. Fetch each apply page once to read og:title (company name) +
 *      recruiting_module_number (the numeric company id) so jobs group into
 *      real companies.
 *   3. Upsert a paylocity company per module number, then upsert its jobs.
 *
 * Descriptions aren't available (the apply page loads them via XHR); the
 * description backfill / dead-job pruning handle that side separately.
 *
 * Exported: scrapePaylocityFromFeed(feedXml, pgClient, { origin, concurrency })
 */

const EMP = { fulltime: 'Full-time', parttime: 'Part-time', contract: 'Contract', temporary: 'Contract', internship: 'Internship' };
const WORK = { onsite: 'On-site', remote: 'Remote', hybrid: 'Hybrid' };

function decode(s) {
  return s ? s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : s;
}
const tag = (block, name) => { const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]) : null; };

// Pull paylocity <job> entries (with their feed fields) out of the raw feed XML.
function parsePaylocityJobs(feedXml) {
  const out = [];
  const blocks = feedXml.split('<job>').slice(1);
  for (const raw of blocks) {
    const block = raw.split('</job>')[0];
    const apply = tag(block, 'application_link') || '';
    const m = apply.match(/recruiting\.paylocity\.com\/Recruiting\/Jobs\/Apply\/(\d+)/i);
    if (!m) continue;
    out.push({
      jobId: m[1],
      applyUrl: apply,
      title: tag(block, 'title'),
      location: tag(block, 'location'),
      employment_type: EMP[(tag(block, 'arrangement') || '').toLowerCase()] || null,
      workplace_type: WORK[(tag(block, 'location_type') || '').toLowerCase()] || null,
    });
  }
  return out;
}

async function runWithConcurrency(items, max, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(max, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }));
}

// Fetch the apply page to read company name (og:title prefix) + module number.
async function fetchCompanyContext(applyUrl) {
  try {
    const res = await fetch(applyUrl, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobChecker/1.0)' } });
    if (!res.ok) return null;
    const html = await res.text();
    const mod = html.match(/"recruiting_module_number"\s*:\s*"?(\d+)"?/);
    const og = html.match(/og:title"\s+content="([^"]+)"/);
    const company = og ? decode(og[1]).replace(/\s*-\s*.*$/, '').trim() : null; // "{Company} - {Title} - ... Application"
    if (!mod) return null;
    return { moduleNumber: mod[1], company };
  } catch { return null; }
}

async function scrapePaylocityFromFeed(feedXml, c, { origin = 'allscmjobs', concurrency = 8 } = {}) {
  const jobs = parsePaylocityJobs(feedXml);
  if (!jobs.length) return { paylocityJobs: 0, companies: 0, inserted: 0 };

  // 1. Resolve company context for each job (apply-page fetch).
  await runWithConcurrency(jobs, concurrency, async (j) => { j.ctx = await fetchCompanyContext(j.applyUrl); });

  // 2. Upsert one company per module number.
  const byModule = new Map();
  for (const j of jobs) { if (j.ctx?.moduleNumber) { if (!byModule.has(j.ctx.moduleNumber)) byModule.set(j.ctx.moduleNumber, j.ctx.company); } }
  const moduleToId = new Map();
  for (const [mod, name] of byModule) {
    const careerUrl = `https://recruiting.paylocity.com/Recruiting/Jobs/All/${mod}`;
    const r = await c.query(
      `INSERT INTO companies (company_name, domain, ats, ats_slug, career_url, status, origin, created_at, updated_at)
       VALUES ($1,$2,'paylocity',$3,$4,'active',$5,NOW(),NOW())
       ON CONFLICT (career_url) DO UPDATE SET company_name = COALESCE(EXCLUDED.company_name, companies.company_name), updated_at = NOW()
       RETURNING id`,
      [name || ('Paylocity ' + mod), 'recruiting.paylocity.com', mod, careerUrl, origin]
    );
    moduleToId.set(mod, r.rows[0].id);
  }

  // 3. Upsert jobs (no description — apply page renders it via XHR).
  let inserted = 0;
  for (const j of jobs) {
    const mod = j.ctx?.moduleNumber; if (!mod) continue;
    const companyId = moduleToId.get(mod); if (!companyId) continue;
    try {
      const r = await c.query(
        `INSERT INTO jobs (external_id, company_id, ats, title, location, workplace_type, employment_type, url, posted_at, first_seen_at, last_seen_at)
         VALUES ($1,$2,'paylocity',$3,$4,$5,$6,$7,NOW(),NOW(),NOW())
         ON CONFLICT (external_id, company_id) DO UPDATE SET
           title = EXCLUDED.title, location = EXCLUDED.location, workplace_type = EXCLUDED.workplace_type,
           employment_type = EXCLUDED.employment_type, url = EXCLUDED.url, posted_at = NOW(),
           last_seen_at = NOW(), removed_at = NULL
         RETURNING (xmax = 0) AS isnew`,
        [j.jobId, companyId, j.title, j.location, j.workplace_type, j.employment_type, j.applyUrl]
      );
      if (r.rows[0]?.isnew) inserted++;
    } catch { /* skip bad row */ }
  }
  return { paylocityJobs: jobs.length, companies: byModule.size, inserted };
}

// Fetch the feed, retrying through the provider's intermittent 504s. A valid feed
// is HTTP 200 AND actually contains <job> entries (the 504 page is ~6KB of HTML).
async function fetchFeedWithRetry(url, { attempts = 8, delayMs = 15000 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
      const text = await res.text();
      if (res.ok && text.includes('<job>')) return text;
      lastErr = `HTTP ${res.status}, ${text.length} bytes, ${text.includes('<job>') ? 'has' : 'no'} <job>`;
    } catch (e) { lastErr = e.message; }
    if (i < attempts) { console.error(`feed attempt ${i} failed (${lastErr}); retrying in ${delayMs / 1000}s`); await new Promise(r => setTimeout(r, delayMs)); }
  }
  throw new Error(`feed never returned valid XML after ${attempts} attempts (last: ${lastErr})`);
}

module.exports = { scrapePaylocityFromFeed, parsePaylocityJobs, fetchFeedWithRetry };

// Standalone runner: fetches the feed itself and loads paylocity jobs to Postgres.
if (require.main === module) {
  const { Client } = require('pg');
  (async () => {
    const FEED = 'https://portal.allscmjobs.com/jobs.xml';
    if (!process.env.DB_URL) { console.error('DB_URL not set'); process.exit(1); }
    console.log('Fetching feed (retrying through 504s)...');
    const feedXml = await fetchFeedWithRetry(FEED);
    console.log(`feed OK: ${feedXml.length} bytes`);
    const c = new Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
    await c.connect();
    console.log('Scraping paylocity jobs...');
    const res = await scrapePaylocityFromFeed(feedXml, c, { origin: 'allscmjobs' });
    console.log('DONE:', JSON.stringify(res));
    await c.end();
    process.exit(0);
  })().catch(e => { console.error('FATAL', e); process.exit(1); });
}
