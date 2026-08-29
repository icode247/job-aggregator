#!/usr/bin/env node
/**
 * Recover the boards that sprout-ingest.js skipped for being claimed by several companies.
 *
 *   node scripts/logo-review/sprout-shared-boards.js          # dry run
 *   node scripts/logo-review/sprout-shared-boards.js --write
 *
 * The blanket skip was too blunt. Inspecting the boards shows two different situations
 * wearing the same shape:
 *
 *   VARIANTS - one employer written several ways. "JPMorgan Chase & Co." / "JPMC" /
 *              "JPMorgan Chase"; "Removery" / "REMOVERY LLC"; "Moose" / "Moose Toys".
 *              Perfectly safe to import once, under the fullest name.
 *
 *   TENANT   - a parent organisation whose board lists distinct child organisations:
 *              "Asbury Elementary School", "East High School", "Manual High School" on one
 *              Oracle tenant. Naming that board after any one child is wrong, so it is still
 *              skipped - the parent's real name is nowhere in the data.
 *
 * The test is whether the names collapse to a shared core: every name either contains, or is
 * contained by, the shortest normalised name on the board. That accepts abbreviation and
 * legal-suffix noise while rejecting a set of genuinely different organisations.
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
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const SUFFIX = /\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|bv|nv|plc|sa|ag|pty|pte|srl|oy|ab|as|group|holdings|kg)\b\.?/g;
const core = s => norm(String(s || '').toLowerCase().replace(SUFFIX, ' '));

const placeSrc = fs.readFileSync(path.join(__dirname, 'sprout-ingest.js'), 'utf8')
  .match(/function place\(url\)[\s\S]*?\n  return null;\n}/)[0];
let place; eval(placeSrc.replace('function place', 'place = function'));

// Placeholder text an ATS renders when the tenant never set a name. Not a company, and
// letting it through would file a real employer under "Candidate Experience site".
const JUNK = /^(candidate ?experience( site| page)?|careers?|jobs?|home|main|external|default)$/i;

/** Is `short` the initials of `long`? JPMC <- J.P.Morgan Chase, MTC <- Management and Training Corp. */
function isAcronymOf(short, long) {
  if (short.length < 2 || short.length > 6) return false;
  // Stopwords have to go BEFORE the initials are taken, not after: "Management and Training
  // Corporation" gives m-a-t-c, and no amount of trimming that string yields "mtc".
  const words = String(long).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter(w => w && !/^(and|of|the|for|a|an)$/.test(w));
  if (words.length < 2) return false;
  const initials = words.map(w => w[0]).join('');
  return initials === short || initials.startsWith(short);
}

/** One employer under several spellings, or several employers on one tenant? */
function isVariantSet(names) {
  const clean = names.filter(n => !JUNK.test(String(n).trim()));
  if (clean.length < 2) return clean.length === 1;   // the rest was placeholder text
  const cores = clean.map(core).filter(Boolean);
  if (cores.length < 2) return false;
  const shortest = cores.reduce((a, b) => (a.length <= b.length ? a : b));
  if (shortest.length < 2) return false;
  const longest = clean.reduce((a, b) => (core(a).length >= core(b).length ? a : b));
  return cores.every(c =>
    c.includes(shortest) || shortest.includes(c) || isAcronymOf(shortest, longest));
}

/** The fullest spelling: most jobs wins, then the longest name (keeps "& Co." over "JPMC"). */
function bestName(entries) {
  const ok = entries.filter(e => !JUNK.test(String(e.n).trim()));
  const pool = ok.length ? ok : entries;
  // Longest first: an acronym wins on job count but tells a reader nothing, so prefer
  // "Management and Training Corporation" over "MTC" even when MTC carries the postings.
  return pool.slice().sort((a, b) => (b.n.length - a.n.length) || (b.j - a.j))[0].n;
}

async function main() {
  const rows = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const HAVE = new Set(fs.readdirSync(path.join(ROOT, 'src', 'adapters'))
    .filter(f => f.endsWith('.js')).map(f => f.replace('.js', '')));

  const claims = new Map();
  for (const r of rows) {
    const p = place(r.sample_url);
    if (!p || !p.slug || !HAVE.has(p.ats)) continue;
    if (!claims.has(p.career_url)) claims.set(p.career_url, []);
    claims.get(p.career_url).push({ n: r.company, j: r.jobs || 0, ...p });
  }
  const shared = [...claims.entries()].filter(([, v]) => v.length > 1);

  const variant = [], tenant = [];
  for (const [url, v] of shared) {
    (isVariantSet(v.map(x => x.n)) ? variant : tenant).push([url, v]);
  }
  const jobs = g => g.reduce((s, [, v]) => s + v.reduce((a, x) => a + x.j, 0), 0);
  console.log(`shared boards: ${shared.length}`);
  console.log(`  name variants of ONE employer -> importable : ${variant.length}  (${jobs(variant)} sprout jobs)`);
  console.log(`  multi-org tenant -> still skipped           : ${tenant.length}  (${jobs(tenant)} sprout jobs)`);
  console.log('\nsample of what will be imported:');
  for (const [, v] of variant.slice(0, 8)) console.log(`   ${bestName(v).slice(0, 40).padEnd(42)} <- ${v.map(x => x.n).join(' / ').slice(0, 60)}`);
  console.log('\nsample of what stays skipped:');
  for (const [, v] of tenant.slice(0, 6)) console.log(`   ${v.map(x => x.n).join(' | ').slice(0, 92)}`);

  const list = variant.map(([url, v]) => ({ name: bestName(v), career_url: url, ats: v[0].ats, slug: v[0].slug }));
  const pool = makePool();
  const have = new Set();
  const urls = list.map(r => r.career_url);
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
