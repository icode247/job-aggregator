#!/usr/bin/env node
/**
 * Measure what the Sprout harvest is actually worth, before anything is written.
 *
 *   node scripts/logo-review/sprout-analyse.js
 *
 * Reads data/logo/sprout-companies.jsonl (from sprout-harvest.js) and answers the only
 * two questions that matter:
 *
 *   1. How many of OUR logo-less companies can this repair?
 *   2. How many of its companies are genuinely new, rather than a name variant of one we
 *      already carry?
 *
 * Matching is deliberately layered, strongest key first. An exact company-name match is
 * the weakest of the three and on its own overstates "new": "JPMorgan Chase & Co." and
 * "JPMorgan Chase" are one company and two names. The ATS slug parsed out of the posting
 * URL is a far stronger key, because both sides derive it from the same board.
 *
 * Writes nothing to the database. Emits data/logo/sprout-matched.json (repairs, for the
 * normal review pipeline) and data/logo/sprout-new.json (unmatched, for a scoping call).
 */
const fs = require('fs');
const path = require('path');
const { makePool, q, isExpiring } = require('./lib.js');

const ROOT = path.resolve(__dirname, '../..');
const IN = path.join(ROOT, 'data', 'logo', 'sprout-companies.jsonl');
const OUT_MATCH = path.join(ROOT, 'data', 'logo', 'sprout-matched.json');
const OUT_NEW = path.join(ROOT, 'data', 'logo', 'sprout-new.json');

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Legal-form suffixes, stripped only for the loosest match tier so "Acme Inc" can meet
// "Acme". Not stripped for the exact tier — see the tier comments below.
const SUFFIX = /\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|bv|nv|plc|sa|ag|pty|pte|srl|oy|ab|as|group|holdings)\b\.?/g;
const normLoose = s => norm(String(s || '').toLowerCase().replace(SUFFIX, ' '));

/**
 * Pull (ats, slug) out of a posting URL. Only shapes where the slug is unambiguous —
 * greenhouse shortlinks (grnh.se/xxxx) carry no slug and are skipped rather than guessed.
 */
function atsSlug(url) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  const h = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  const m = (ats, s) => (s ? { ats, slug: String(s).toLowerCase() } : null);

  if (/(^|\.)(job-boards|boards)\.greenhouse\.io$/.test(h)) return m('greenhouse', seg[0]);
  if (/(^|\.)jobs\.lever\.co$/.test(h)) return m('lever', seg[0]);
  if (/(^|\.)apply\.workable\.com$/.test(h)) return m('workable', seg[0]);
  if (/(^|\.)jobs\.ashbyhq\.com$/.test(h)) return m('ashby', seg[0]);
  if (/(^|\.)(jobs\.)?smartrecruiters\.com$/.test(h)) return m('smartrecruiters', seg[0]);
  if (/(^|\.)recruitee\.com$/.test(h)) return m('recruitee', h.split('.')[0]);
  if (/(^|\.)breezy\.hr$/.test(h)) return m('breezy', h.split('.')[0]);
  if (/(^|\.)bamboohr\.com$/.test(h)) return m('bamboohr', h.split('.')[0]);
  if (/myworkdayjobs\.com$/.test(h)) return m('workday', h.split('.')[0]);
  if (/(^|\.)ats\.rippling\.com$/.test(h)) return m('rippling', seg[0]);
  if (/icims\.com$/.test(h)) return m('icims', h.split('.')[0]);
  if (/(^|\.)teamtailor\.com$/.test(h)) return m('teamtailor', h.split('.')[0]);
  if (/(^|\.)jobs\.personio\.(com|de)$/.test(h)) return m('personio', h.split('.')[0]);
  return null;
}

async function main() {
  // Collapse the job-level rows to one row per company. Later rows win only if the
  // earlier one had no logo, so a company's first good logo sticks.
  const companies = new Map();
  let rows = 0, expiring = 0;
  for (const line of fs.readFileSync(IN, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    rows++;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!j.company || !j.logo) continue;
    if (isExpiring(j.logo)) { expiring++; continue; }
    const key = norm(j.company);
    if (!key) continue;
    const cur = companies.get(key);
    if (!cur) companies.set(key, { name: j.company, logo: j.logo, urls: [j.url], n: 1 });
    else { cur.n++; if (cur.urls.length < 4 && j.url) cur.urls.push(j.url); }
  }
  console.log(`harvest rows: ${rows} | distinct companies: ${companies.size}` +
    (expiring ? ` | ${expiring} rejected as expiring` : ''));

  const pool = makePool();
  const db = await q(pool, 'SELECT id, company_name, logo_url, ats, ats_slug FROM companies');
  console.log(`our companies: ${db.rows.length}`);

  // Three indexes over our side, strongest key first.
  const bySlug = new Map();   // "<ats>:<slug>"
  const byExact = new Map();  // normalised full name
  const byLoose = new Map();  // normalised, legal suffixes dropped
  for (const c of db.rows) {
    if (c.ats && c.ats_slug) {
      const k = `${String(c.ats).toLowerCase()}:${String(c.ats_slug).toLowerCase()}`;
      if (!bySlug.has(k)) bySlug.set(k, c);
    }
    const e = norm(c.company_name);
    if (e && !byExact.has(e)) byExact.set(e, c);
    const l = normLoose(c.company_name);
    if (l && !byLoose.has(l)) byLoose.set(l, c);
  }

  const matched = [];      // ours, currently logo-less -> repairable
  const matchedHas = [];   // ours, already has a logo
  const fresh = [];        // no match on any key
  const tier = { slug: 0, exact: 0, loose: 0 };

  for (const [key, s] of companies) {
    let hit = null, how = null;
    for (const u of s.urls) {
      const a = atsSlug(u);
      if (a) {
        const c = bySlug.get(`${a.ats}:${a.slug}`);
        if (c) { hit = c; how = 'slug'; break; }
      }
    }
    if (!hit) { const c = byExact.get(key); if (c) { hit = c; how = 'exact'; } }
    if (!hit) { const c = byLoose.get(normLoose(s.name)); if (c) { hit = c; how = 'loose'; } }

    if (hit) {
      tier[how]++;
      const rec = { id: hit.id, company_name: hit.company_name, sprout_name: s.name,
                    logo_url: s.logo, matched_by: how };
      if (hit.logo_url) matchedHas.push(rec); else matched.push(rec);
    } else {
      fresh.push({ company: s.name, logo: s.logo, jobs: s.n, sample_url: s.urls[0] || null });
    }
  }

  fs.writeFileSync(OUT_MATCH, JSON.stringify(matched, null, 2));
  fs.writeFileSync(OUT_NEW, JSON.stringify(fresh, null, 2));

  const tot = companies.size;
  const pc = n => `${(n / tot * 100).toFixed(1)}%`;
  console.log('');
  console.log(`matched to a company we already have : ${matched.length + matchedHas.length} (${pc(matched.length + matchedHas.length)})`);
  console.log(`    by ATS slug  : ${tier.slug}`);
  console.log(`    by exact name: ${tier.exact}`);
  console.log(`    by loose name: ${tier.loose}`);
  console.log(`  -> of those, MISSING a logo        : ${matched.length}   <- repairable now`);
  console.log(`  -> already have a logo             : ${matchedHas.length}`);
  console.log(`NOT in our database                  : ${fresh.length} (${pc(fresh.length)})`);
  console.log('');
  console.log(`wrote ${OUT_MATCH} and ${OUT_NEW}`);
  await pool.end();
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
