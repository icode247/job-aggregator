#!/usr/bin/env node
/**
 * Recover the Sprout companies hiding behind redirect wrappers.
 *
 *   node scripts/logo-review/sprout-resolve-import.js          # dry run
 *   node scripts/logo-review/sprout-resolve-import.js --write
 *
 * Two url shapes carry no board information until they are followed:
 *
 *   t.gohiring.com/h/<hash>       - a tracking wrapper. A 60-url sample landed 80% on
 *                                   Personio tenants, which we already crawl.
 *   apply.workable.com/j/<code>   - a job shortlink. The board is only visible after the
 *                                   redirect, which is why the naive parse produced the
 *                                   slug "j" for 222 different employers.
 *
 * Everything else is unchanged: resolved urls go through the SAME place() used by
 * sprout-ingest.js, so only boards we own an adapter for are ever inserted, and a board
 * claimed by more than one company is still skipped rather than misnamed.
 */
const fs = require('fs');
const path = require('path');
const { makePool, q } = require('./lib.js');

const ROOT = path.resolve(__dirname, '../..');
const IN = path.join(ROOT, 'data', 'logo', 'sprout-new-verified.json');
const CACHE = path.join(ROOT, 'data', 'logo', 'sprout-resolved.json');
const WRITE = process.argv.includes('--write');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36';

const host = u => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };

// Reuse the ingest placer verbatim rather than restating it - two copies would drift, and a
// drift here means rows whose career_url no adapter can open.
const ingestSrc = fs.readFileSync(path.join(__dirname, 'sprout-ingest.js'), 'utf8');
const placeSrc = ingestSrc.match(/function place\(url\)[\s\S]*?\n  return null;\n}/)[0];
const segs = u => { try { return new URL(u).pathname.split('/').filter(Boolean); } catch { return []; } };
const LOCALE = /^[a-z]{2}(-[A-Za-z]{2})?$/;
let place; eval(placeSrc.replace('function place', 'place = function'));

const WRAPPED = /(^|\.)t\.gohiring\.com$/;
const SHORTLINK = u => /(^|\.)apply\.workable\.com$/.test(host(u)) && segs(u)[0] === 'j';

async function resolveOne(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 20000);
    const r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: c.signal });
    clearTimeout(t);
    return r.url || null;
  } catch { return null; }
}

async function main() {
  const rows = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const targets = rows.filter(r => WRAPPED.test(host(r.sample_url) || '') || SHORTLINK(r.sample_url));
  console.log(`redirect-wrapped companies: ${targets.length}`);

  // Resolutions are cached: they are slow, and a re-run should not re-hit their servers.
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { }
  const todo = targets.filter(r => !cache[r.sample_url]);
  console.log(`already resolved: ${targets.length - todo.length} | to resolve: ${todo.length}`);

  let next = 0, done = 0;
  const worker = async () => {
    while (next < todo.length) {
      const r = todo[next++];
      cache[r.sample_url] = (await resolveOne(r.sample_url)) || 'FAIL';
      if (++done % 100 === 0) {
        fs.writeFileSync(CACHE, JSON.stringify(cache));
        console.log(`  resolved ${done}/${todo.length}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  fs.writeFileSync(CACHE, JSON.stringify(cache));

  const HAVE = new Set(fs.readdirSync(path.join(ROOT, 'src', 'adapters'))
    .filter(f => f.endsWith('.js')).map(f => f.replace('.js', '')));

  const claims = new Map();
  const landed = {}; let failed = 0, noAdapter = 0;
  for (const r of targets) {
    const dest = cache[r.sample_url];
    if (!dest || dest === 'FAIL') { failed++; continue; }
    const p = place(dest);
    if (!p || !p.slug || !HAVE.has(p.ats)) { noAdapter++; landed[host(dest) || '?'] = (landed[host(dest) || '?'] || 0) + 1; continue; }
    if (!claims.has(p.career_url)) claims.set(p.career_url, []);
    claims.get(p.career_url).push({ name: r.company, ...p });
  }

  const list = [...claims.entries()].filter(([, v]) => v.length === 1).map(([, v]) => v[0]);
  const shared = [...claims.entries()].filter(([, v]) => v.length > 1).length;
  const byAts = {}; for (const r of list) byAts[r.ats] = (byAts[r.ats] || 0) + 1;
  console.log(`\nresolve failed: ${failed} | landed on a board with no adapter: ${noAdapter} | shared boards skipped: ${shared}`);
  console.log(`placeable: ${list.length}`);
  Object.entries(byAts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`   ${String(v).padStart(5)} ${k}`));
  console.log('\ntop destinations with no adapter:');
  Object.entries(landed).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([k, v]) => console.log(`   ${String(v).padStart(5)} ${k}`));

  const pool = makePool();
  const urls = list.map(r => r.career_url);
  const have = new Set();
  for (let i = 0; i < urls.length; i += 1000) {
    const r = await q(pool, 'SELECT career_url FROM companies WHERE career_url = ANY($1)', [urls.slice(i, i + 1000)]);
    for (const x of r.rows) have.add(x.career_url);
  }
  const fresh = list.filter(r => !have.has(r.career_url));
  console.log(`\nalready held: ${have.size} | WOULD INSERT: ${fresh.length}`);
  if (!WRITE) { console.log('DRY RUN - nothing written.'); await pool.end(); return; }

  const CHUNK = 200; let inserted = 0;
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const slice = fresh.slice(i, i + CHUNK);
    const values = slice.map((_, n) => `($${n * 6 + 1},$${n * 6 + 2},$${n * 6 + 3},$${n * 6 + 4},$${n * 6 + 5},$${n * 6 + 6})`).join(',');
    const params = slice.flatMap(r => [r.name, r.career_url, host(r.career_url), r.ats, r.slug, 'sprout_import']);
    const res = await q(pool, `
      INSERT INTO companies (company_name, career_url, domain, ats, ats_slug, origin, status, created_at, updated_at)
      SELECT v.name, v.url, v.dom, v.ats, v.slug, v.origin, 'active', NOW(), NOW()
        FROM (VALUES ${values}) AS v(name, url, dom, ats, slug, origin)
      ON CONFLICT (career_url) DO NOTHING
    `, params);
    inserted += res.rowCount;
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`INSERTED ${inserted}`);
  await pool.end();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
