#!/usr/bin/env node
/**
 * Seed companies from an external ATS-slug dump (out/slugs_by_ats.json: {ats: [{name,slug,url}]}).
 * Only ATS we have a working crawl adapter for, and only in the slug FORMAT that adapter's
 * fetchJobs() expects (validated live before writing this). New companies are inserted status=active
 * so the crawl fleet picks them up; dedup is by (ats, ats_slug) against existing rows so we never
 * create a duplicate company (which would double-crawl and duplicate jobs).
 *
 * Skipped: oracle (Fusion — separate fetcher pending), personio (adapter rejects the host format),
 * taleo (odd full-URL format, low volume).
 *
 * Run:  SLUGS_FILE=/Users/codev/ats-slugs/out/slugs_by_ats.json DATABASE_URL=... node scripts/import-ats-slugs.js
 *       DRY=1 ... (report only)
 */
const { query, closeDb } = require('../src/db/connection');
const logger = require('../src/logger');

const FILE = process.env.SLUGS_FILE || '/Users/codev/ats-slugs/out/slugs_by_ats.json';
const DRY = process.env.DRY === '1';
const host = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };

// file-key -> { ats, slug(entry)->crawlable slug, url(entry,slug)->canonical career_url }
const MAP = {
  ashby:           { ats: 'ashby',           slug: (e) => e.slug, url: (e) => e.url },
  greenhouse:      { ats: 'greenhouse',      slug: (e) => e.slug, url: (e) => e.url },
  lever:           { ats: 'lever',           slug: (e) => e.slug, url: (e) => e.url },
  recruitee:       { ats: 'recruitee',       slug: (e) => e.slug, url: (e) => e.url },
  rippling:        { ats: 'rippling',        slug: (e) => e.slug, url: (e) => e.url },
  pinpoint:        { ats: 'pinpoint',        slug: (e) => e.slug, url: (e) => e.url },
  paylocity:       { ats: 'paylocity',       slug: (e) => e.slug, url: (e) => e.url },
  bamboohr:        { ats: 'bamboohr',        slug: (e) => e.slug, url: (e) => e.url },
  smartrecruiters: { ats: 'smartrecruiters', slug: (e) => e.slug, url: (e) => e.url },
  breezy:          { ats: 'breezy',          slug: (e) => e.slug, url: (e) => e.url },
  workable:        { ats: 'workable',        slug: (e) => e.slug, url: (e) => e.url },
  jazzhr:          { ats: 'jazzhr',          slug: (e) => e.slug, url: (e) => e.url },
  teamtailor:      { ats: 'teamtailor',      slug: (e) => e.slug, url: (e) => e.url },
  // zoho takes a bare tenant slug, matching how existing rows are stored (prognova, celworld).
  // The adapter probes zohorecruit .com/.in/.eu/.com.au in turn, so the URL below is only a
  // human-facing default — resolution happens at crawl time, not here.
  zoho:            { ats: 'zoho',            slug: (e) => e.slug, url: (e, s) => `https://${s}.zohorecruit.com` },
  // transformed to the adapter-expected format:
  icims:           { ats: 'icims',           slug: (e) => host(e.url).replace(/\.icims\.com$/, ''), url: (e, s) => `https://${s}.icims.com` },
  workday:         { ats: 'workday',         slug: (e) => String(e.slug).split('/')[0], url: (e, s) => `https://${s}.myworkdayjobs.com` },
  successfactors:  { ats: 'successfactors',  slug: (e) => host(e.url), url: (e) => e.url },
};

async function flush(rows) {
  if (!rows.length || DRY) return 0;
  const vals = []; const params = [];
  rows.forEach((r, i) => { const b = i * 6;
    vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},'active',$${b + 6},NOW(),NOW())`);
    params.push(r.name || null, r.domain, r.ats, r.slug, r.careerUrl, 'atsslugs');
  });
  const res = await query(
    `INSERT INTO companies (company_name,domain,ats,ats_slug,career_url,status,origin,created_at,updated_at)
       VALUES ${vals.join(',')}
     ON CONFLICT (career_url) DO NOTHING
     RETURNING id`, params);
  return res.rowCount;
}

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }
  const data = require(FILE);
  let grandNew = 0, grandSkip = 0;
  for (const [key, cfg] of Object.entries(MAP)) {
    const entries = data[key] || [];
    if (!entries.length) continue;
    // existing (ats, ats_slug) for this ats -> skip set
    const { rows: ex } = await query('SELECT LOWER(ats_slug) s FROM companies WHERE ats = $1 AND ats_slug IS NOT NULL', [cfg.ats]);
    const seen = new Set(ex.map((r) => r.s));
    let batch = [], added = 0, skipped = 0;
    for (const e of entries) {
      let slug; try { slug = cfg.slug(e); } catch { continue; }
      if (!slug) { skipped++; continue; }
      const key2 = String(slug).toLowerCase();
      if (seen.has(key2)) { skipped++; continue; }
      seen.add(key2); // also dedups within the file
      let careerUrl; try { careerUrl = cfg.url(e, slug); } catch { continue; }
      const domain = host(careerUrl) || slug;
      if (!careerUrl || !domain) { skipped++; continue; }
      batch.push({ name: e.name, domain, ats: cfg.ats, slug, careerUrl });
      if (batch.length >= 500) { added += await flush(batch); batch = []; }
    }
    added += await flush(batch);
    grandNew += added; grandSkip += skipped;
    logger.info({ ats: cfg.ats, fileCount: entries.length, inserted: DRY ? 0 : added, skippedExisting: skipped }, `seeded ${cfg.ats}`);
  }
  logger.info({ inserted: DRY ? 0 : grandNew, skippedExisting: grandSkip, dry: DRY }, 'ATS-slug seed COMPLETE');
  await closeDb();
  process.exit(0);
})().catch((e) => { logger.error({ err: e.message, stack: e.stack }, 'ats-slug seed fatal'); process.exit(1); });
