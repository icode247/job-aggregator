#!/usr/bin/env node
/**
 * Automate workable-slug discovery — replaces manual Google dorking.
 *
 * For each keyword (job title), searches Workable's marketplace API
 * (jobs.workable.com/api/v1/jobs?query=...), slugifies the company names into
 * candidate apply.workable.com account slugs, VERIFIES each new candidate against
 * apply.workable.com/api/v3 (through the IPRoyal proxy, since that host is
 * IP-blocked), and imports the confirmed-real ones as active workable companies
 * (last_synced_at=NULL so instance E crawls them immediately).
 *
 * Usage:
 *   DATABASE_URL=... node scripts/discover-workable-by-keyword.js "Purchasing Agent" "Returns Specialist"
 *   DATABASE_URL=... node scripts/discover-workable-by-keyword.js --file keywords.txt
 * Env: MAX_PAGES_PER_KEYWORD (default 10), VERIFY_CONCURRENCY (default 6).
 */
const fs = require('fs');
const { query, closeDb } = require('../src/db/connection');
const proxy = require('../src/utils/proxy');

const MARKET = 'https://jobs.workable.com/api/v1/jobs';
const MAX_PAGES = parseInt(process.env.MAX_PAGES_PER_KEYWORD || '10', 10);
const VCONC = parseInt(process.env.VERIFY_CONCURRENCY || '6', 10);
const CORP = /-(ltd|inc|llc|limited|gmbh|sa|srl|bv|pty|corp|co|group|holdings|international|inc-\d+)$/;

function slugify(title) {
  return String(title || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’.,()]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
// candidate slug variants for one company title
function variants(title) {
  const base = slugify(title);
  const out = new Set([base]);
  if (CORP.test(base)) out.add(base.replace(CORP, ''));
  return [...out].filter(Boolean);
}

async function searchKeyword(kw) {
  const titles = new Map(); // slugCandidate -> companyTitle (for logging)
  let pageToken = null, pages = 0;
  while (pages < MAX_PAGES) {
    const url = `${MARKET}?query=${encodeURIComponent(kw)}&location=` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    let d;
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) break;
      d = await res.json();
    } catch { break; }
    const jobs = d.jobs || [];
    if (!jobs.length) break;
    for (const j of jobs) {
      const t = j.company && j.company.title;
      if (t) variants(t).forEach((v) => { if (!titles.has(v)) titles.set(v, t); });
    }
    pages++;
    pageToken = d.nextPageToken;
    if (!pageToken) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return titles;
}

// verify a candidate slug resolves on apply.workable.com (proxied). 200 => real.
async function verify(slug) {
  try {
    const res = await fetch(`https://apply.workable.com/api/v3/accounts/${encodeURIComponent(slug)}/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      dispatcher: proxy.newAgent(), signal: AbortSignal.timeout(15000),
    });
    if (res.status === 200) { const d = await res.json(); return { ok: true, jobs: (d.results || []).length }; }
    return { ok: false, status: res.status };
  } catch (e) { return { ok: false, status: e.message }; }
}

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }
  if (!proxy.enabled) { console.error('IPRoyal proxy not configured (need IPROYAL_* in .env)'); process.exit(1); }

  const args = process.argv.slice(2);
  let keywords = [];
  const fi = args.indexOf('--file');
  if (fi >= 0) keywords = fs.readFileSync(args[fi + 1], 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  else keywords = args.filter((a) => a !== '--file');
  if (!keywords.length) { console.error('Provide keywords or --file keywords.txt'); process.exit(1); }

  console.log(`Discovering workable slugs for ${keywords.length} keyword(s)...`);
  const candidates = new Map();
  for (const kw of keywords) {
    const found = await searchKeyword(kw);
    found.forEach((title, slug) => { if (!candidates.has(slug)) candidates.set(slug, title); });
    console.log(`  "${kw}": ${found.size} candidate slugs (running total ${candidates.size})`);
  }

  // drop candidates we already have as workable companies
  const allSlugs = [...candidates.keys()];
  const existing = new Set();
  for (const grp of chunk(allSlugs, 300)) {
    const { rows } = await query(`SELECT ats_slug FROM companies WHERE ats='workable' AND ats_slug IN (${grp.map(() => '?').join(',')})`, grp);
    rows.forEach((r) => existing.add(r.ats_slug));
  }
  const toVerify = allSlugs.filter((s) => !existing.has(s));
  console.log(`\n${allSlugs.length} unique candidates | ${existing.size} already in DB | verifying ${toVerify.length} new...`);

  // verify (proxied, concurrent)
  const confirmed = [];
  let vi = 0, done = 0;
  await Promise.all(Array.from({ length: VCONC }, async () => {
    while (vi < toVerify.length) {
      const slug = toVerify[vi++];
      const r = await verify(slug);
      done++;
      if (r.ok) confirmed.push(slug);
      if (done % 25 === 0) console.log(`  verified ${done}/${toVerify.length} (confirmed ${confirmed.length})`);
    }
  }));
  console.log(`\nConfirmed real: ${confirmed.length}/${toVerify.length}`);

  // import confirmed (active, null-synced -> E crawls immediately)
  let inserted = 0;
  const title = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  for (const grp of chunk(confirmed, 120)) {
    const vals = [], p = [];
    grp.forEach((s) => { vals.push('(?,?,?,?,?,?,?,NOW(),NULL,NOW())'); p.push(`https://apply.workable.com/${s}`, 'apply.workable.com', 'workable', s, title(s), 'keyword_discovery', 'active'); });
    const r = await query(`INSERT INTO companies (career_url,domain,ats,ats_slug,company_name,origin,status,created_at,last_synced_at,updated_at) VALUES ${vals.join(',')} ON CONFLICT (career_url) DO NOTHING`, p);
    inserted += r.rowCount;
  }
  console.log(`Imported ${inserted} new workable companies (origin=keyword_discovery).`);
  await closeDb();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
