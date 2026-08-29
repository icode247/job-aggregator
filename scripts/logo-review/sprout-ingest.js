#!/usr/bin/env node
/**
 * Insert the Sprout companies we can actually crawl.
 *
 *   node scripts/logo-review/sprout-ingest.js          # dry run - prints, writes nothing
 *   node scripts/logo-review/sprout-ingest.js --write  # insert
 *
 * Only companies whose board we already own an adapter for. A row we cannot sync is worse
 * than no row: it shows up in counts, never carries a live job, and has to be cleaned up later.
 *
 * career_url is the table's UNIQUE key, so it is also the dedup key here - and it has to be
 * built in each adapter's own shape, not invented. Sampling existing rows first is what makes
 * this safe: personio wants https://<tenant>.jobs.personio.com, oracle wants the full
 * CandidateExperience path with the site id, and workday needs the pod (wd501) that only
 * exists in the posting host. Guessing any of those would produce rows that never sync.
 *
 * NOT set: logo_url. Sprout hands us a logo for every one of these, but nothing reaches
 * companies.logo_url without going through the normal preview + approve loop. The dictionary
 * keeps them, so they can be reviewed as a normal batch afterwards.
 */
const fs = require('fs');
const path = require('path');
const { makePool, q } = require('./lib.js');

const ROOT = path.resolve(__dirname, '../..');
const IN = path.join(ROOT, 'data', 'logo', 'sprout-new-verified.json');
const WRITE = process.argv.includes('--write');

const host = u => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };
const segs = u => { try { return new URL(u).pathname.split('/').filter(Boolean); } catch { return []; } };
const LOCALE = /^[a-z]{2}(-[A-Za-z]{2})?$/;

/**
 * Return {ats, slug, career_url} in the shape this codebase already stores, or null when the
 * board is one we have no adapter for (those are reported, never inserted).
 */
function place(url) {
  const h = host(url); if (!h) return null;
  const s = segs(url);
  const sub = h.split('.')[0];
  const R = (ats, slug, career_url) => ({ ats, slug, career_url });

  if (/(^|\.)jobs\.personio\.(com|de)$/.test(h)) return R('personio', sub, `https://${h}`);
  if (/(^|\.)applytojob\.com$/.test(h)) return R('jazzhr', sub, `https://${h}`);
  if (/(^|\.)teamtailor\.com$/.test(h)) return R('teamtailor', sub, `https://${h}`);
  if (/zohorecruit\.(com|in|eu)$/.test(h)) return R('zoho', sub, `https://${h}`);
  if (/(^|\.)recruitee\.com$/.test(h)) return R('recruitee', sub, `https://${h}`);
  if (/(^|\.)breezy\.hr$/.test(h)) return R('breezy', sub, `https://${h}`);
  if (/(^|\.)pinpointhq\.com$/.test(h)) return R('pinpoint', sub, `https://${h}`);
  // tbe.taleo.net hosts are SHARED pods: phg.tbe.taleo.net alone serves 50 unrelated
  // employers, whose identity lives in the careersection path, not the subdomain. Treating
  // the pod as a tenant would file Crane Currency and 1199SEIU as the same company.
  if (/tbe\.taleo\.net$/.test(h)) return null;
  if (/taleo\.net$/.test(h)) return R('taleo', sub, `https://${h}`);
  if (/(^|\.)bamboohr\.com$/.test(h)) return R('bamboohr', sub, `https://${h}`);
  if (/icims\.com$/.test(h)) return R('icims', sub, `https://${h}`);
  if (/(^|\.)(job-boards|boards)(\.eu)?\.greenhouse\.io$/.test(h) && s[0]) return R('greenhouse', s[0], `https://job-boards.greenhouse.io/${s[0]}`);
  if (/(^|\.)jobs\.lever\.co$/.test(h) && s[0]) return R('lever', s[0], `https://jobs.lever.co/${s[0]}`);
  if (/(^|\.)jobs\.eu\.lever\.co$/.test(h) && s[0]) return R('lever', s[0], `https://jobs.eu.lever.co/${s[0]}`);
  // apply.workable.com/j/<code> is a JOB shortlink, not a company board. Taking s[0] here
  // yields the slug "j" for every one of them - 222 different employers collapsing onto
  // https://apply.workable.com/j. Exactly the mangled-slug trap that has bitten this repo before.
  if (/(^|\.)apply\.workable\.com$/.test(h)) return (s[0] && s[0] !== 'j') ? R('workable', s[0], `https://apply.workable.com/${s[0]}`) : null;
  if (/smartrecruiters\.com$/.test(h) && s[0]) return R('smartrecruiters', s[0], `https://careers.smartrecruiters.com/${s[0]}`);
  if (/(^|\.)ats\.rippling\.com$/.test(h) && s[0]) return R('rippling', s[0], `https://ats.rippling.com/${s[0]}`);
  if (/(^|\.)jobs\.ashbyhq\.com$/.test(h) && s[0]) return R('ashby', s[0], `https://jobs.ashbyhq.com/${s[0]}`);

  // The pod (wd501) lives only in the posting host, and the site is the first path segment
  // that is not a locale. Both are required for the board to resolve.
  if (/myworkdayjobs\.com$|myworkdaysite\.com$/.test(h)) {
    const site = s.find(x => !LOCALE.test(x) && x !== 'job');
    if (!site) return null;
    return R('workday', sub, `https://${h}/${site}`);
  }

  // Oracle's identity is tenant + pod + site; the slug convention already in the table is
  // "<tenant>.<pod>.<site>" (e.g. hcld.em2.CX_1).
  if (/oraclecloud\.com$/.test(h)) {
    const i = s.indexOf('sites');
    const site = i >= 0 ? s[i + 1] : null;
    if (!site) return null;
    const parts = h.split('.');
    const pod = parts.length >= 4 ? parts[parts.length - 3] : '';
    return R('oracle', `${parts[0]}${pod ? '.' + pod : ''}.${site}`,
      `https://${h}/hcmUI/CandidateExperience/en/sites/${site}`);
  }
  return null;
}

async function main() {
  const rows = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const HAVE = new Set(fs.readdirSync(path.join(ROOT, 'src', 'adapters'))
    .filter(f => f.endsWith('.js')).map(f => f.replace('.js', '')));

  const claims = new Map();   // career_url -> every sprout company that lands on it
  const skipped = new Map();
  for (const r of rows) {
    const p = place(r.sample_url);
    if (!p || !p.slug || !HAVE.has(p.ats)) {
      const h = host(r.sample_url) || '?';
      skipped.set(h, (skipped.get(h) || 0) + 1);
      continue;
    }
    if (!claims.has(p.career_url)) claims.set(p.career_url, []);
    claims.get(p.career_url).push({ name: r.company, ...p, jobs: r.jobs || 0 });
  }

  // A board claimed by several Sprout companies is one employer's board listing its
  // sub-units - one Oracle tenant carrying a whole school district, a co-op group, a
  // hospital network. We cannot tell which name is the employer, and picking the first
  // would file the entire tenant under "Asbury Elementary School". Skip them; a missing
  // row is recoverable, a misnamed one quietly pollutes the board.
  const shared = [...claims.entries()].filter(([, v]) => v.length > 1);
  const list = [...claims.entries()].filter(([, v]) => v.length === 1).map(([, v]) => v[0]);
  console.log(`skipped ${shared.length} shared boards (${shared.reduce((a, [, v]) => a + v.length, 0)} sprout companies) - cannot tell which name owns the board`);
  const byAts = {};
  for (const r of list) byAts[r.ats] = (byAts[r.ats] || 0) + 1;
  console.log(`candidates: ${rows.length} | placeable on an adapter we own: ${list.length}` +
    ` (deduped from ${rows.length - [...skipped.values()].reduce((a, b) => a + b, 0)})`);
  Object.entries(byAts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`   ${String(v).padStart(5)} ${k}`));

  const pool = makePool();
  // Which career_urls do we already hold? Checked in chunks so the IN-list stays small.
  const urls = list.map(r => r.career_url);
  const have = new Set();
  for (let i = 0; i < urls.length; i += 1000) {
    const r = await q(pool, 'SELECT career_url FROM companies WHERE career_url = ANY($1)', [urls.slice(i, i + 1000)]);
    for (const x of r.rows) have.add(x.career_url);
  }
  const fresh = list.filter(r => !have.has(r.career_url));
  console.log(`\nalready in companies (by career_url): ${have.size}`);
  console.log(`WOULD INSERT: ${fresh.length}`);
  console.log('\nsample:');
  for (const r of fresh.slice(0, 6)) console.log(`   ${r.ats.padEnd(16)} ${String(r.slug).slice(0, 26).padEnd(28)} ${r.career_url}`);

  if (!WRITE) { console.log('\nDRY RUN - nothing written. Re-run with --write to insert.'); await pool.end(); return; }

  // Small batches on purpose: this table backs the live API and bulk writes have starved it
  // before. ON CONFLICT keeps a concurrent crawler insert from turning into an error.
  const CHUNK = 200;
  let inserted = 0;
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const slice = fresh.slice(i, i + CHUNK);
    const values = slice.map((_, n) => `($${n * 6 + 1},$${n * 6 + 2},$${n * 6 + 3},$${n * 6 + 4},$${n * 6 + 5},$${n * 6 + 6})`).join(',');
    // domain is NOT NULL, and for an ATS-hosted board the table's own convention is the
    // career_url's host (matrix42.jobs.personio.com), not a corporate website. That is also
    // why domain was useless as a matching key earlier: for most rows it IS the board.
    const params = slice.flatMap(r => [r.name, r.career_url, host(r.career_url), r.ats, r.slug, 'sprout_import']);
    const res = await q(pool, `
      INSERT INTO companies (company_name, career_url, domain, ats, ats_slug, origin, status, created_at, updated_at)
      SELECT v.name, v.url, v.dom, v.ats, v.slug, v.origin, 'active', NOW(), NOW()
        FROM (VALUES ${values}) AS v(name, url, dom, ats, slug, origin)
      ON CONFLICT (career_url) DO NOTHING
    `, params);
    inserted += res.rowCount;
    if ((i / CHUNK) % 5 === 0) console.log(`  ${Math.min(i + CHUNK, fresh.length)}/${fresh.length} | inserted ${inserted}`);
    await new Promise(r => setTimeout(r, 150));   // breathe; the API shares this database
  }
  console.log(`\nINSERTED ${inserted} companies (origin=sprout_import, status=active, no logo_url)`);
  await pool.end();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
