#!/usr/bin/env node
/**
 * Verify a harvested slice and fill any holes, without re-walking ids already captured.
 *
 *   node scripts/logo-review/sprout-verify.js <offset|all> [concurrency]
 *
 * Two harvest runs finished "successfully" while short — a timeout was indistinguishable
 * from a genuine 404, so lost ids became invisible gaps. The harvester now records the ids
 * it gives up on, but runs that predate that leave no list. This reconstructs one.
 *
 * The trick is that a slice's id set is fully known (LO + offset, step STRIDE), and the
 * corpus records every id that produced a job. Every id in the slice NOT in the corpus is
 * either genuinely empty (~35% of the band) or a hole. Re-probing just those costs ~35% of
 * a full walk instead of 100%, and anything that answers 200 was a hole.
 *
 * Appends recovered rows to the same corpus file. Safe to re-run: duplicates are collapsed
 * by company in sprout-analyse.js.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'data', 'logo', 'sprout-companies.jsonl');

const LO = 66546875;
const HI = 68125000;
const STRIDE = 10;

const ARG = String(process.argv[2] || '');
const CONC = Math.max(1, parseInt(process.argv[3] || '25', 10));
const TIMEOUT = 12000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const EXPIRING = /[?&](Expires|X-Amz-Expires|Signature|X-Amz-Signature|Key-Pair-Id)=/i;

const MISSING = Symbol('missing');
const DROPPED = Symbol('dropped');

async function fetchOnce(id) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(`https://api.usesprout.com/jobs/${id}`, {
      headers: { 'user-agent': UA, accept: 'application/json' }, signal: ctl.signal,
    });
    if (res.status === 404) return MISSING;
    if (!res.ok) return DROPPED;
    const j = await res.json();
    return j && j.id ? j : MISSING;
  } catch { return DROPPED; } finally { clearTimeout(timer); }
}

// More patient than the harvester: this pass exists precisely because the first one gave
// up too early, and it runs against a much smaller id set.
async function getJob(id) {
  for (let a = 0; a < 6; a++) {
    const r = await fetchOnce(id);
    if (r !== DROPPED) return r;
    await new Promise(res => setTimeout(res, 500 * (a + 1)));
  }
  return DROPPED;
}

function corpusIds() {
  const seen = new Set();
  const data = fs.readFileSync(OUT, 'utf8');
  for (const line of data.split('\n')) {
    if (!line) continue;
    const i = line.indexOf('"id":');
    if (i < 0) continue;
    const n = parseInt(line.slice(i + 5), 10);
    if (n) seen.add(n);
  }
  return seen;
}

async function verifySlice(offset, seen) {
  const absent = [];
  for (let id = LO + offset; id <= HI; id += STRIDE) if (!seen.has(id)) absent.push(id);
  console.log(`slice ${offset}: ${absent.length} ids absent from corpus — re-probing`);

  const t0 = Date.now();
  let next = 0, done = 0, recovered = 0, stillDropped = 0;
  let buf = [];
  const worker = async () => {
    while (next < absent.length) {
      const id = absent[next++];
      const j = await getJob(id);
      done++;
      if (j === DROPPED) stillDropped++;
      else if (j !== MISSING && j.companyLogo && !EXPIRING.test(j.companyLogo)) {
        recovered++;
        buf.push(JSON.stringify({ id: j.id, company: j.company, logo: j.companyLogo,
          url: j.postingUrl || null, industry: j.industry || null }));
      }
      if (buf.length >= 500) { fs.appendFileSync(OUT, buf.join('\n') + '\n'); buf = []; }
      if (done % 10000 === 0) {
        const rate = done / ((Date.now() - t0) / 1000);
        console.log(`  ${done}/${absent.length} | recovered ${recovered} | ${rate.toFixed(0)} req/s`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  if (buf.length) fs.appendFileSync(OUT, buf.join('\n') + '\n');

  console.log(`VERIFY slice ${offset} | probed ${done} absent ids in ${((Date.now() - t0) / 60000).toFixed(1)}m | ` +
    `RECOVERED ${recovered} holes` + (stillDropped ? ` | ${stillDropped} still unreachable` : ' | clean'));
  return { recovered, stillDropped };
}

async function main() {
  if (!ARG) { console.error('usage: sprout-verify.js <offset|all> [conc]'); process.exit(1); }
  const offsets = ARG === 'all' ? [...Array(STRIDE).keys()] : [parseInt(ARG, 10)];
  let total = 0, unreachable = 0;
  for (const off of offsets) {
    // Re-read per slice: earlier slices in this same run append to the corpus.
    const seen = corpusIds();
    const r = await verifySlice(off, seen);
    total += r.recovered; unreachable += r.stillDropped;
  }
  console.log(`\nTOTAL recovered ${total} holes` + (unreachable ? `, ${unreachable} still unreachable` : ''));
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
