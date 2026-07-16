#!/usr/bin/env node
/**
 * Comeet company discovery via SERP + page-embedded token extraction.
 *
 * Comeet (now "Spark Hire Recruit") gates its careers-api behind {UID}:{TOKEN}.
 * The company root page is a JS shell, BUT the individual job pages that Google
 * indexes are SEO-rendered and embed the config in plain JSON:
 *     "uid": "DA.006", "token": "AD64...", "slug": "zyg"
 * So: dork site:comeet.com/jobs for roles -> pull job URLs -> per new company
 * fetch ONE job page -> extract uid+token -> upsert as ats_slug "{uid}:{token}".
 * The comeet adapter then crawls all positions.
 *
 * Run: DATABASE_URL=... node scripts/discover-comeet.js
 * Env: ROLES_OVERRIDE (comma list; default job-roles.js), SERP_DEPTH (default 4),
 *      GROUP_SIZE (default 5), SKIP_INDUSTRIES (default none — comeet is small).
 */
const { query, closeDb } = require('../src/db/connection');
const { ROLES_BY_INDUSTRY } = require('./job-roles');

const env = (() => {
  const fs = require('fs'); const e = {};
  try { fs.readFileSync(require('path').join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) e[m[1]] = m[2]; }); } catch { /* */ }
  return { ...e, ...process.env };
})();
const BD_KEY = env.BRIGHT_DATA_API_KEY;
const BD_ZONE = env.BRIGHT_DATA_ZONE || 'web_unlocker1';
const DEPTH = parseInt(env.SERP_DEPTH || '4', 10);
const GROUP = parseInt(env.GROUP_SIZE || '5', 10);
const q = async (s, p) => { for (let i = 0; i < 8; i++) { try { return await query(s, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 2500 * (i + 1))); } } };
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

async function bd(url) {
  const r = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + BD_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ zone: BD_ZONE, url, format: 'raw' }),
    signal: AbortSignal.timeout(45000),
  });
  return await r.text();
}

// Google dork -> raw HTML, paginated; return matched comeet {slug -> {uid, sampleUrl}}
async function dorkCompanies(titlesOr, found) {
  const dork = `site:comeet.com/jobs (${titlesOr})`;
  for (let page = 0; page < DEPTH; page++) {
    let before = found.size;
    const url = `https://www.google.com/search?q=${encodeURIComponent(dork)}&num=100&start=${page * 100}`;
    let html; try { html = await bd(url); } catch { break; }
    const rx = /comeet\.com\/jobs\/([a-zA-Z0-9._-]+)\/([0-9A-Fa-f]{2}\.[0-9A-Fa-f]{3})\/[a-zA-Z0-9._%-]+\/[0-9A-Fa-f.]+/g;
    let m;
    while ((m = rx.exec(html)) !== null) {
      const slug = m[1].toLowerCase(); const uid = m[2].toUpperCase();
      if (!found.has(slug)) found.set(slug, { uid, sampleUrl: m[0].startsWith('http') ? m[0] : 'https://www.' + m[0] });
    }
    if (found.size === before && page > 0) break; // no new — stop paginating
  }
}

// Fetch one job page, extract ONLY the company token. The company UID comes from
// the URL path (the page has many position/department "uid" fields — the first is
// NOT the company). Never throws — a BD timeout/error just yields null.
async function extractToken(sampleUrl) {
  let html;
  try { html = await bd(sampleUrl); } catch { return null; }
  return (html.match(/"token":\s*"([0-9A-Fa-f]{20,})"/) || [])[1] || null;
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }
  if (!BD_KEY) { console.error('Set BRIGHT_DATA_API_KEY'); process.exit(1); }

  const roles = env.ROLES_OVERRIDE
    ? env.ROLES_OVERRIDE.split(',').map((s) => s.trim()).filter(Boolean)
    : Object.values(ROLES_BY_INDUSTRY).reduce((a, r) => a.concat(r), []);
  const groups = chunk(roles, GROUP);
  console.log(`Comeet discovery | ${roles.length} roles | ${groups.length} dorks of ${GROUP} | depth ${DEPTH}`);

  // existing comeet slugs (career_url uid) so we skip known
  const known = new Set((await q('SELECT ats_slug FROM companies WHERE ats=$1', ['comeet'])).rows.map((r) => (r.ats_slug || '').split(':')[0].toUpperCase()));

  // Interleaved: after each dork, extract token + import the NEW companies it
  // surfaced, so progress is saved incrementally (survives a DB blip / kill).
  const found = new Map();
  const seen = new Set();       // slugs we've already handled (imported/failed/known)
  let imported = 0, tokFail = 0, skipped = 0;
  for (let g = 0; g < groups.length; g++) {
    await dorkCompanies(groups[g].map((r) => `"${r}"`).join(' OR '), found);
    for (const [slug, { uid, sampleUrl }] of found) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      if (known.has(uid)) { skipped++; continue; }
      const token = await extractToken(sampleUrl);   // company UID comes from the URL
      if (!token) { tokFail++; continue; }
      try {
        await q(
          `INSERT INTO companies (company_name, ats, ats_slug, career_url, domain, status, origin, last_synced_at, created_at, updated_at)
           VALUES ($1,'comeet',$2,$3,$4,'active','serp_discovery',NULL,NOW(),NOW())
           ON CONFLICT (career_url) DO UPDATE SET ats_slug=EXCLUDED.ats_slug, status='active', updated_at=NOW()`,
          [slug, `${uid}:${token}`, `https://www.comeet.co/jobs/${uid}`, 'www.comeet.co']);
        known.add(uid); imported++;
      } catch (e) { console.error(`  upsert fail ${slug}: ${e.message}`); }
    }
    if (g % 5 === 0) console.log(`  [dork ${g + 1}/${groups.length}] found ${found.size} | imported ${imported} | skipped ${skipped} | tokFail ${tokFail}`);
  }
  console.log(`DONE. Imported ${imported} new comeet companies | skipped(known) ${skipped} | token-extract failed ${tokFail}`);
  await closeDb();
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
