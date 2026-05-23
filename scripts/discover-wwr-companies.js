#!/usr/bin/env node
/**
 * Discover which WeWorkRemotely "Anywhere in the World" companies have a job
 * board on our four prioritized ATSes (ashby, greenhouse, workable, breezy).
 *
 * Pipeline:
 *   1. Read all WWR CSVs in --csv-glob (default: ~/Downloads/wwr_anywhere_jobs*.csv)
 *   2. Deduplicate companies by normalized name
 *   3. Match against our companies table (by normalized name OR ats_slug)
 *   4. For unmatched: probe each ATS's public API with ~15 slug variants per name
 *   5. For still-unmatched: optionally Google-search "<role> <company>" on each
 *      ATS's domain to catch slugs the variant generator missed
 *   6. Print results and (if --apply) insert any new findings into the
 *      companies table so the sync worker picks them up.
 *
 * Idempotent — `--apply` uses ON CONFLICT (career_url) DO UPDATE, so re-running
 * never produces duplicates.
 *
 * Usage:
 *   DATABASE_URL=$(heroku config:get DATABASE_URL -a fastapply-board) \
 *     node scripts/discover-wwr-companies.js
 *
 *   # Apply findings to DB:
 *   ... node scripts/discover-wwr-companies.js --apply
 *
 *   # Process a custom file:
 *   ... node scripts/discover-wwr-companies.js --csv=path/to/jobs.csv
 */

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Pool } = require('pg');

// ---------- CLI ----------
const args = process.argv.slice(2);
const argFor = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const APPLY      = args.includes('--apply');
const CONCURRENCY = parseInt(argFor('concurrency', '8'), 10);
const CSV_PATH    = argFor('csv', null);
const CSV_GLOB    = argFor('csv-glob', path.join(os.homedir(), 'Downloads', 'wwr_anywhere_jobs*.csv'));

const TARGET_ATSES = ['ashby', 'greenhouse', 'workable', 'breezy'];

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ---------- CSV loading ----------
function loadCsvFiles() {
  let files = [];
  if (CSV_PATH) {
    files = [CSV_PATH];
  } else {
    // expand the glob — homemade since Node has no built-in glob
    const dir = path.dirname(CSV_GLOB);
    const baseGlob = path.basename(CSV_GLOB);
    const regex = new RegExp('^' + baseGlob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    files = fs.readdirSync(dir).filter((f) => regex.test(f)).map((f) => path.join(dir, f));
  }
  console.log(`Loading ${files.length} CSV file(s):`);
  const recs = []; // {title, company}
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const lines = text.split(/\r?\n/).slice(1); // header
    let n = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      const m = line.match(/^"([^"]*)","([^"]*)","([^"]*)"/);
      if (!m) continue;
      recs.push({ title: m[1], company: m[2] });
      n++;
    }
    console.log(`  ${n.toString().padStart(4)} rows  ${path.basename(f)}`);
  }
  return recs;
}

function normName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[,.&'"`]/g, '')
    .replace(/[-_/]+/g, ' ')
    .replace(/\b(inc|ltd|llc|gmbh|sa|technologies|technology|tech|software|labs?|hq|corp|systems?|group|co|company|pte|ag|the|oy|ab|bv|nv|spzoo|spzo)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Slug variant generator ----------
const CORPORATE_WORDS = new Set([
  'inc','ltd','llc','gmbh','sa','technologies','technology','tech','software',
  'lab','labs','hq','corp','corporation','systems','system','group','co','company',
  'pte','ag','oy','ab','bv','nv','holdings','solutions','services','consulting',
  'studios','studio','agency','partners','platform','ventures','media','digital',
]);

function slugVariants(name) {
  const out = new Set();
  const raw = name.trim();
  if (!raw) return [];

  const stripPunct = (s) => s.replace(/[,.&'"`]/g, '').replace(/[/\\]/g, ' ');
  const collapse = (s) => s.replace(/\s+/g, ' ').trim();

  // base: lowercased, punctuation stripped
  const base = collapse(stripPunct(raw)).toLowerCase();
  if (!base) return [];

  const words = base.split(/\s+/);
  const wordsNoFiller = words.filter((w) => w !== 'the' && w !== 'a' && w !== 'an' && !CORPORATE_WORDS.has(w));
  const wordsNoCorp = words.filter((w) => !CORPORATE_WORDS.has(w));

  // 1-3. raw lowercased, no-sep / dash / underscore
  out.add(base.replace(/\s+/g, ''));
  out.add(base.replace(/\s+/g, '-'));
  out.add(base.replace(/\s+/g, '_'));

  // 4-6. corporate stripped, no-sep / dash / underscore
  if (wordsNoCorp.length && wordsNoCorp.length !== words.length) {
    const s = wordsNoCorp.join(' ');
    out.add(s.replace(/\s+/g, ''));
    out.add(s.replace(/\s+/g, '-'));
    out.add(s.replace(/\s+/g, '_'));
  }

  // 7-9. filler-words stripped (the/a/an + corporate)
  if (wordsNoFiller.length && wordsNoFiller.length !== words.length) {
    const s = wordsNoFiller.join(' ');
    out.add(s.replace(/\s+/g, ''));
    out.add(s.replace(/\s+/g, '-'));
    out.add(s.replace(/\s+/g, '_'));
  }

  // 10. PascalCase variant (preserves original casing meaningfully — Ashby often uses this)
  out.add(raw.replace(/[^a-zA-Z0-9]/g, ''));
  out.add(raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase());

  // 11-12. First meaningful word
  if (wordsNoFiller[0] && wordsNoFiller[0].length >= 3) out.add(wordsNoFiller[0]);
  if (words[0] && words[0] !== 'the' && words[0].length >= 3) out.add(words[0]);

  // 13. First two meaningful words concatenated / hyphenated
  if (wordsNoFiller.length >= 2) {
    const two = wordsNoFiller.slice(0, 2);
    out.add(two.join(''));
    out.add(two.join('-'));
  }

  // 14. Acronym from meaningful words — disabled. Short slugs (2-3 chars)
  // produced a flood of false positives because plenty of generic slugs like
  // "trt", "sa", "ml", "hh" exist as orphaned breezy/ashby boards that
  // belong to entirely different companies. We rely on full-name variants
  // instead.

  // 15. Replace " & " with "and" or with nothing
  if (/\s&\s/.test(raw)) {
    const a = raw.toLowerCase().replace(/\s&\s/g, 'and').replace(/[^\w\s-]/g, '');
    const b = raw.toLowerCase().replace(/\s&\s/g, '').replace(/[^\w\s-]/g, '');
    for (const s of [a, b]) {
      const t = collapse(s);
      out.add(t.replace(/\s+/g, ''));
      out.add(t.replace(/\s+/g, '-'));
    }
  }

  // 16. Brand often suffixes AI/HR/HQ — keep as a separate variant
  for (const suffix of ['ai', 'hq', 'hr', 'app', 'io']) {
    if (wordsNoFiller[0]) {
      out.add(wordsNoFiller[0] + suffix);
      out.add(wordsNoFiller[0] + '-' + suffix);
    }
  }

  // 17. Strip apostrophes and possessives ('s)
  const noApos = base.replace(/'s\b/g, '').replace(/'/g, '');
  out.add(noApos.replace(/\s+/g, ''));
  out.add(noApos.replace(/\s+/g, '-'));

  // Clean: length 5..60. Anything 4 or shorter is too prone to colliding with
  // someone else's orphan slug on the same ATS.
  return [...out].filter((s) => s && s.length >= 5 && s.length <= 60);
}

// ---------- ATS API probes ----------
const fetchOpts = (extra = {}) => ({
  headers: { 'User-Agent': 'job-aggregator-discover/1.0' },
  signal: AbortSignal.timeout(8000),
  ...extra,
});

// All probes require a non-empty job list — an "exists but empty" board is
// almost always a stale account that doesn't belong to our target company.
async function probeAshby(slug) {
  try {
    const r = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`, fetchOpts());
    if (!r.ok) return false;
    const d = await r.json().catch(() => null);
    return !!(d && Array.isArray(d.jobs) && d.jobs.length > 0);
  } catch { return false; }
}
async function probeGreenhouse(slug) {
  try {
    const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=false&per_page=1`, fetchOpts());
    if (!r.ok) return false;
    const d = await r.json().catch(() => null);
    return !!(d && Array.isArray(d.jobs) && d.jobs.length > 0);
  } catch { return false; }
}
async function probeWorkable(slug) {
  try {
    const r = await fetch(`https://apply.workable.com/api/v3/accounts/${encodeURIComponent(slug)}?details=true`, fetchOpts());
    if (!r.ok) return false;
    const d = await r.json().catch(() => null);
    // Workable's account endpoint returns the company name even if no jobs are
    // live — we additionally check `data.jobs_count` (when present) to filter
    // out dormant accounts.
    if (!d || !d.name) return false;
    if (typeof d.jobs_count === 'number' && d.jobs_count <= 0) return false;
    return true;
  } catch { return false; }
}
async function probeBreezy(slug) {
  try {
    const r = await fetch(`https://${slug}.breezy.hr/json`, fetchOpts({ redirect: 'manual' }));
    if (r.status !== 200) return false;
    const d = await r.json().catch(() => null);
    return !!(d && Array.isArray(d) && d.length > 0);
  } catch { return false; }
}
const PROBES = { ashby: probeAshby, greenhouse: probeGreenhouse, workable: probeWorkable, breezy: probeBreezy };

// ---------- Verification (kill false positives) ----------
// After a slug returns a non-empty board, we fetch the board's public HTML
// page and extract the company name from the <title>. We then compare it to
// the WWR-listed name using a normalized fuzzy match. Hits that fail are
// dropped — these are nearly always "someone-else's-orphan-board" false
// positives where a generic slug (`pulse`, `method`, `orchard`, etc.) on
// the same ATS happens to belong to a completely different company.
async function fetchBoardCompanyName(ats, slug) {
  const url = ats === 'ashby'      ? `https://jobs.ashbyhq.com/${slug}`
            : ats === 'greenhouse' ? `https://boards.greenhouse.io/${slug}`
            : ats === 'workable'   ? `https://apply.workable.com/${slug}`
            :                        `https://${slug}.breezy.hr/`;
  try {
    const r = await fetch(url, fetchOpts({ redirect: 'follow' }));
    if (!r.ok) return null;
    const html = await r.text();
    // Try <title> first
    const t = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1];
    if (t) {
      // Strip broken template placeholders Breezy/Greenhouse leave behind
      // when a board hasn't set a custom title:
      //   - "%DOC_TITLE%CompanyName" (Breezy)
      //   - "page_title" / "%TITLE%" (Greenhouse)
      let cleaned = t
        .replace(/^%[A-Z_]+%/g, '')          // Breezy: %DOC_TITLE%
        .replace(/^\{\{[^}]+\}\}/g, '')      // Mustache-style placeholders
        // Strip ATS suffixes ("| Powered by Ashby", "- Greenhouse Jobs", " Jobs", etc.)
        .replace(/\s*[\|\-–·•]\s*(careers|jobs|hiring|open positions?|job openings?|recruiting).*$/i, '')
        .replace(/\s*[\|\-–·•]\s*(powered by|via)\s+(ashby|greenhouse|breezy|workable|breezyhr).*$/i, '')
        .replace(/\s*[\|\-–·•]\s*(ashby|greenhouse|breezy|workable|breezyhr).*$/i, '')
        // " Jobs" / " Careers" suffix without a separator (Ashby's default)
        .replace(/\s+(jobs|careers|hiring|open\s+positions?|job\s+openings?)$/i, '')
        .replace(/^(careers?|jobs?|hiring|open positions?|job openings?|join (us|the team))\s*(at|@|with)?\s+/i, '')
        .replace(/^we'?re hiring at\s+/i, '')
        .replace(/^work at\s+/i, '')
        .replace(/\s*['’]s open jobs?$/i, '')
        .trim();
      // Known placeholder strings = treat as no-title (let slug-fallback decide)
      if (/^(page_title|untitled|home|welcome|careers|jobs|open positions?)$/i.test(cleaned)) {
        cleaned = '';
      }
      if (cleaned && cleaned.length > 1) return cleaned;
    }
    // Fall back to og:site_name / og:title
    const og = (html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) || [])[1]
            || (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || [])[1];
    return og || null;
  } catch { return null; }
}

function isNameMatch(wwrName, boardName) {
  const na = normName(wwrName);
  const nb = normName(boardName);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Full substring match (covers "Linear" vs "Linear Inc" — corporate words
  // already stripped by normName). Require length 5+ to avoid generic single
  // words like "remote", "talent", "method" matching unrelated boards.
  if (na.length >= 5 && nb === na) return true;
  if (nb.length >= 5 && na === nb) return true;
  if (na.length >= 5 && nb.includes(' ' + na + ' ')) return true;
  if (nb.length >= 5 && na.includes(' ' + nb + ' ')) return true;
  // Strict token containment: every meaningful WWR-name token must appear in
  // the board name. Keep 2-char tokens (e.g. "AI" in "Stellar AI") because
  // they're often important brand qualifiers — without them, "Stellar AI"
  // collapses to "stellar" and matches Stellar Development Foundation.
  const wwrTokens = na.split(' ').filter((w) => w.length >= 2);
  const boardTokens = new Set(nb.split(' '));
  if (wwrTokens.length === 0) return false;
  return wwrTokens.every((t) => boardTokens.has(t));
}

// ---------- Main pipeline ----------
async function loadDbIndex() {
  const { rows } = await pool.query(
    `SELECT ats, ats_slug, company_name FROM companies
       WHERE ats = ANY($1::text[]) AND status = 'active'`,
    [TARGET_ATSES],
  );
  const idx = new Map();
  function add(key, ats, slug) {
    if (!key) return;
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push({ ats, slug });
  }
  for (const r of rows) {
    add(normName(r.company_name), r.ats, r.ats_slug);
    add(normName(r.ats_slug),     r.ats, r.ats_slug);
  }
  console.log(`Loaded ${rows.length} existing rows across ${TARGET_ATSES.join('/')}.\n`);
  return idx;
}

async function probeCompany(name, sampleTitle) {
  const variants = slugVariants(name);
  const hits = {};
  const rejected = [];  // [{ats, slug, foundName}]
  // Sequential per-ATS to keep total request count down; variants tried in order.
  for (const ats of TARGET_ATSES) {
    for (const v of variants) {
      if (await PROBES[ats](v)) {
        // Verify: fetch the board's HTML and confirm the company name matches.
        const foundName = await fetchBoardCompanyName(ats, v);
        if (foundName && isNameMatch(name, foundName)) {
          hits[ats] = v;
          break;
        }
        // Fallback: accept when the slug is a faithful rendering of the WWR
        // name (slug equals normName-concat or normName-hyphen). This catches
        // boards whose HTML title is broken/generic but whose slug is clearly
        // specific to this company (e.g. "lucidsoftware", "stickermule",
        // "gno-partners", "reveleer"). Triggers regardless of whether
        // foundName was extracted — short generic slugs like "method" or
        // "orchard" never match this fallback so we don't reintroduce FPs.
        const nv = (v || '').toLowerCase();
        const expectedConcat = normName(name).replace(/\s+/g, '');
        const expectedHyphen = normName(name).replace(/\s+/g, '-');
        const slugLooksLikeName = nv.length >= 6 && (nv === expectedConcat || nv === expectedHyphen);
        if (slugLooksLikeName) {
          hits[ats] = v;
          break;
        }
        rejected.push({ ats, slug: v, foundName: foundName || '<no title>' });
      }
    }
  }
  return { hits, variantsTried: variants.length, rejected };
}

async function insertCompany({ ats, slug, name }) {
  const cu = ats === 'ashby'      ? `https://jobs.ashbyhq.com/${slug}`
           : ats === 'greenhouse' ? `https://boards.greenhouse.io/${slug}`
           : ats === 'workable'   ? `https://apply.workable.com/${slug}`
           :                        `https://${slug}.breezy.hr`;
  const dom = ats === 'breezy' ? `${slug}.breezy.hr` : new URL(cu).hostname;
  const { rows } = await pool.query(
    `INSERT INTO companies (career_url, domain, ats, ats_slug, status, origin, company_name, last_discovered_at)
     VALUES ($1, $2, $3, $4, 'active', 'wwr-discover', $5, NOW())
     ON CONFLICT (career_url) DO UPDATE SET
       ats = COALESCE(companies.ats, EXCLUDED.ats),
       ats_slug = COALESCE(companies.ats_slug, EXCLUDED.ats_slug),
       status = CASE WHEN companies.status IN ('pending','failed') THEN 'active' ELSE companies.status END,
       company_name = COALESCE(companies.company_name, EXCLUDED.company_name),
       updated_at = NOW()
     RETURNING (xmax = 0) AS inserted`,
    [cu, dom, ats, slug, name],
  );
  return rows[0].inserted;
}

async function main() {
  console.log('═'.repeat(78));
  console.log('WWR company discovery');
  console.log('  apply:        ' + (APPLY ? 'YES — will insert new rows' : 'no (dry)'));
  console.log('═'.repeat(78));

  const recs = loadCsvFiles();
  const byCompany = new Map();
  for (const r of recs) {
    if (!byCompany.has(r.company)) byCompany.set(r.company, []);
    byCompany.get(r.company).push(r.title);
  }
  console.log(`\nUnique companies: ${byCompany.size} (across ${recs.length} job postings)`);

  // 1) DB match
  const dbIdx = await loadDbIndex();
  const dbHits = [];
  const toProbe = [];
  for (const [company, titles] of byCompany.entries()) {
    const n = normName(company);
    if (dbIdx.has(n)) dbHits.push({ company, ats: dbIdx.get(n).map((x) => x.ats), source: 'db' });
    else toProbe.push({ company, sampleTitle: titles[0] });
  }
  console.log(`  matched in DB:  ${dbHits.length}`);
  console.log(`  need probing:   ${toProbe.length}\n`);

  // 2) Probe
  console.log(`Probing ${toProbe.length} unmatched companies × ${TARGET_ATSES.length} ATSes (concurrency ${CONCURRENCY})...`);
  const results = [];
  let next = 0;
  async function worker() {
    while (next < toProbe.length) {
      const i = next++;
      const item = toProbe[i];
      const r = await probeCompany(item.company, item.sampleTitle);
      results[i] = { ...item, ...r };
      process.stdout.write(Object.keys(r.hits).length ? '+' : '.');
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log('\n');

  // 3) Tally
  const probeHits = results.filter((r) => Object.keys(r.hits).length > 0);
  const unknown   = results.filter((r) => Object.keys(r.hits).length === 0);

  const byAts = { ashby: new Map(), greenhouse: new Map(), workable: new Map(), breezy: new Map() };
  // DB hits — dedupe by company name (a single company can have many rows)
  for (const h of dbHits) {
    for (const a of new Set(h.ats)) {
      if (!byAts[a].has(h.company)) byAts[a].set(h.company, { name: h.company, source: 'db' });
    }
  }
  // Probe hits
  for (const h of probeHits) {
    for (const [a, slug] of Object.entries(h.hits)) {
      if (!byAts[a].has(h.company)) byAts[a].set(h.company, { name: h.company, slug, source: 'probe' });
    }
  }

  for (const a of TARGET_ATSES) {
    const list = [...byAts[a].values()];
    console.log(`\n=== ${a.toUpperCase()}: ${list.length} companies ===`);
    for (const c of list) {
      const tag = c.source === 'probe' ? ` (NEW, slug=${c.slug})` : '';
      console.log(`  ${c.name}${tag}`);
    }
  }
  console.log(`\n=== Still unknown: ${unknown.length} ===`);
  if (unknown.length) {
    console.log('  ' + unknown.slice(0, 15).map((u) => u.company).join(', ')
      + (unknown.length > 15 ? `, ... (+${unknown.length - 15} more)` : ''));
  }

  // Show rejected-by-verification cases so we can audit the filter
  const allRejected = [];
  for (const r of results) {
    if (r.rejected && r.rejected.length) {
      for (const rj of r.rejected) allRejected.push({ company: r.company, ...rj });
    }
  }
  if (allRejected.length) {
    console.log(`\n=== Rejected by name-verification (${allRejected.length}) — possible misses to audit ===`);
    for (const r of allRejected.slice(0, 30)) {
      console.log(`  ${r.company.padEnd(35)} -> ${r.ats}/${r.slug.padEnd(25)} (board name: "${r.foundName.slice(0, 50)}")`);
    }
    if (allRejected.length > 30) console.log(`  ... (+${allRejected.length - 30} more)`);
  }

  // Persist findings for downstream tools
  fs.writeFileSync('/tmp/wwr-probe-results.json', JSON.stringify({ dbHits, probeHits, unknown }, null, 2));
  fs.writeFileSync('/tmp/wwr-stillunknown.txt', unknown.map((u) => u.company).join('\n'));

  // 4) Apply: insert probe hits into companies
  if (APPLY && probeHits.length) {
    console.log(`\nInserting ${probeHits.length} newly-discovered companies into prod...`);
    let inserted = 0, existing = 0;
    for (const r of probeHits) {
      for (const [ats, slug] of Object.entries(r.hits)) {
        try {
          const ok = await insertCompany({ ats, slug, name: r.company });
          if (ok) { inserted++; } else { existing++; }
        } catch (e) { console.log(`  err on ${r.company}/${ats}: ${e.message}`); }
      }
    }
    console.log(`  ${inserted} truly-new rows, ${existing} already existed (career_url conflict).`);
  } else if (!APPLY) {
    console.log('\n(dry run — pass --apply to insert into the companies table)');
  }

  await pool.end();
}

main().catch((err) => { console.error('FATAL:', err); pool.end().catch(() => {}); process.exit(1); });
