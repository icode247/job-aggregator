#!/usr/bin/env node
/**
 * Run the FULL job-roles.js vocabulary (1683 roles) through workable marketplace
 * keyword-discovery, in GROUPS OF 5 roles, all pages each. For each group:
 *   marketplace search per role -> slugify company names -> dedup vs DB ->
 *   verify new candidates on apply.workable.com (via IPRoyal proxy) -> import
 *   confirmed as active workable companies (origin=keyword_discovery, null-synced).
 *
 * Checkpoints the last completed group to /tmp/discover-roles.checkpoint so a
 * restart resumes where it left off (also honours START_GROUP env override).
 *
 * Run (background):
 *   DATABASE_URL=... node scripts/discover-all-roles.js
 * Env: GROUP_SIZE(5), MAX_PAGES_PER_KEYWORD(6), VERIFY_CONCURRENCY(4).
 */
const fs = require('fs');
const { query, closeDb } = require('../src/db/connection');
const proxy = require('../src/utils/proxy');
const { ROLES_BY_INDUSTRY } = require('./job-roles');
// Skip industries the user has already covered manually (substring match, case-insensitive).
const SKIP = (process.env.SKIP_INDUSTRIES || 'Technology,Supply Chain').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const ALL_ROLES = Object.entries(ROLES_BY_INDUSTRY)
  .filter(([ind]) => !SKIP.some((s) => ind.toLowerCase().includes(s)))
  .reduce((a, [, roles]) => a.concat(roles), []);

const GROUP_SIZE = parseInt(process.env.GROUP_SIZE || '5', 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES_PER_KEYWORD || '6', 10);
const VCONC = parseInt(process.env.VERIFY_CONCURRENCY || '4', 10);
// Safety cap: stop after this many proxied verify requests (~30KB each) so a run
// can't silently exhaust the metered IPRoyal plan. Raise + resume for more.
const MAX_VERIFY = parseInt(process.env.MAX_VERIFY || '12000', 10);
const CKPT = '/tmp/discover-roles.checkpoint';
const CORP = /-(ltd|inc|llc|limited|gmbh|sa|srl|bv|pty|corp|co|group|holdings|international)$/;

const slugify = (t) => String(t || '').toLowerCase().replace(/&/g, ' and ').replace(/['’.,()]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const variants = (t) => { const b = slugify(t); const o = new Set([b]); if (CORP.test(b)) o.add(b.replace(CORP, '')); return [...o].filter(Boolean); };
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const q = async (s, p) => { for (let i = 0; i < 8; i++) { try { return await query(s, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 2500 * (i + 1))); } } };

async function searchKeyword(kw) {
  const cands = new Map();
  let pageToken = null, pages = 0;
  while (pages < MAX_PAGES) {
    const url = `https://jobs.workable.com/api/v1/jobs?query=${encodeURIComponent(kw)}&location=` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    let d;
    try { const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) }); if (!res.ok) break; d = await res.json(); } catch { break; }
    const jobs = d.jobs || [];
    if (!jobs.length) break;
    for (const j of jobs) { const t = j.company && j.company.title; if (t) variants(t).forEach((v) => cands.set(v, t)); }
    pages++; pageToken = d.nextPageToken;
    if (!pageToken) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  return cands;
}

async function verify(slug) {
  try {
    const res = await fetch(`https://apply.workable.com/api/v3/accounts/${encodeURIComponent(slug)}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', dispatcher: proxy.newAgent(), signal: AbortSignal.timeout(15000) });
    return res.status === 200;
  } catch { return false; }
}

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }
  if (!proxy.enabled) { console.error('IPRoyal proxy not configured'); process.exit(1); }

  const groups = chunk(ALL_ROLES, GROUP_SIZE);
  let start = parseInt(process.env.START_GROUP || '0', 10);
  if (!process.env.START_GROUP && fs.existsSync(CKPT)) { const c = parseInt(fs.readFileSync(CKPT, 'utf8').trim(), 10); if (!isNaN(c)) start = c; }
  console.log(`job-roles discovery | ${ALL_ROLES.length} roles | ${groups.length} groups of ${GROUP_SIZE} | starting at group ${start}`);

  const rejected = new Set(); // in-memory: don't re-verify known-bad this run
  let totalImported = 0, totalVerified = 0;
  for (let g = start; g < groups.length; g++) {
    if (totalVerified >= MAX_VERIFY) { console.log(`Hit MAX_VERIFY cap (${MAX_VERIFY}) at group ${g}. Stopping — raise MAX_VERIFY and rerun to resume from checkpoint.`); break; }
    const roles = groups[g];
    const cands = new Map();
    for (const kw of roles) { const found = await searchKeyword(kw); found.forEach((title, slug) => cands.set(slug, title)); }
    const allSlugs = [...cands.keys()].filter((s) => s && !rejected.has(s));

    // dedup vs DB (any ats-workable row)
    const existing = new Set();
    for (const grp of chunk(allSlugs, 300)) { const { rows } = await q(`SELECT ats_slug FROM companies WHERE ats='workable' AND ats_slug IN (${grp.map(() => '?').join(',')})`, grp); rows.forEach((r) => existing.add(r.ats_slug)); }
    const toVerify = allSlugs.filter((s) => !existing.has(s));

    // verify (proxied, concurrent)
    const confirmed = [];
    let vi = 0;
    await Promise.all(Array.from({ length: VCONC }, async () => {
      while (vi < toVerify.length) { const slug = toVerify[vi++]; if (await verify(slug)) confirmed.push(slug); else rejected.add(slug); }
    }));
    totalVerified += toVerify.length;

    // import confirmed
    let inserted = 0;
    const title = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    for (const grp of chunk(confirmed, 120)) {
      const vals = [], p = [];
      grp.forEach((s) => { vals.push('(?,?,?,?,?,?,?,NOW(),NULL,NOW())'); p.push(`https://apply.workable.com/${s}`, 'apply.workable.com', 'workable', s, title(s), 'keyword_discovery', 'active'); });
      const r = await q(`INSERT INTO companies (career_url,domain,ats,ats_slug,company_name,origin,status,created_at,last_synced_at,updated_at) VALUES ${vals.join(',')} ON CONFLICT (career_url) DO NOTHING`, p);
      inserted += r.rowCount;
    }
    totalImported += inserted;
    fs.writeFileSync(CKPT, String(g + 1));
    console.log(`[grp ${g + 1}/${groups.length}] roles=[${roles.join(' | ').slice(0, 60)}...] cand=${allSlugs.length} new=${toVerify.length} confirmed=${confirmed.length} imported=${inserted} | TOTAL imported ${totalImported}, verified ${totalVerified}`);
  }
  console.log(`DONE. Total imported ${totalImported} across ${groups.length} groups.`);
  await closeDb();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
