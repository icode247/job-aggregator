#!/usr/bin/env node
/**
 * Harvest the company -> logo dictionary from Sprout's open job-detail endpoint.
 *
 *   node scripts/logo-review/sprout-harvest.js [strideDenominator] [concurrency] [offset]
 *
 * This does NOT write to the database. It appends to data/logo/sprout-companies.jsonl,
 * which analyse/export steps read later. Nothing reaches companies.logo_url without
 * going through the normal preview + save-logos review.
 *
 * Why this exists at all: sprout-logos.js GUESSED the CDN slug from the company name and
 * scored 17%, because "Fox Pest Control" and "Adams State University" collapse to slugs
 * that belong to somebody else. GET /jobs/<id> is unauthenticated and returns the real
 * companyLogo URL, so the slug never has to be inferred.
 *
 *   {"id":67845963,"company":"Catawiki",
 *    "companyLogo":"https://d3q08qjq3lm2dy.cloudfront.net/logos/catawiki.png", ...}
 *
 * The id space was probed, not assumed: ids below ~66.55M and above ~68.13M are empty,
 * and inside the band roughly 65% of ids resolve. There is no listing endpoint without a
 * bearer token (60-minute life), so the band is walked directly.
 *
 * STRIDE: walking every id in the band is ~1.58M requests. A stride of N walks every Nth
 * id — evenly spread rather than randomly sampled, so a partial run is still a uniform
 * sample of the whole band AND is resumable, which a random sample is not.
 *
 * OFFSET selects which of the N interleaved passes to walk, so the band can be covered in
 * slices without redoing work: stride 10 offset 0 is the pilot, offsets 1..9 are the rest.
 * Each (stride, offset) keeps its own cursor, so a slice that dies resumes where it
 * stopped rather than restarting or clobbering a sibling slice.
 *
 * Company discovery does not saturate: in a 392-job sample, 341 companies were distinct.
 * So coverage scales with how much of the band is walked; a small run does not "mostly
 * get everything".
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'data', 'logo', 'sprout-companies.jsonl');
const stateFile = () => path.join(ROOT, 'data', 'logo',
  `sprout-harvest-state${STRIDE}-${OFFSET}.json`);
// Ids this slice gave up on. Recording them turns "re-walk 157,813 ids" into "retry the
// 1,102 that actually failed" — slice offset=6 lost 0.70% and, without this, cost a full
// 22-minute re-walk to recover them.
const dropFile = () => path.join(ROOT, 'data', 'logo',
  `sprout-harvest-drops${STRIDE}-${OFFSET}.txt`);

// Measured edges, not guesses — see the header. Kept a little wide on purpose: an empty
// id costs one cheap 404 and the band may drift as they post more jobs.
const LO = 66546875;
const HI = 68125000;

const STRIDE = Math.max(1, parseInt(process.argv[2] || '10', 10));
const CONC = Math.max(1, parseInt(process.argv[3] || '50', 10));
const OFFSET = Math.max(0, parseInt(process.argv[4] || '0', 10)) % STRIDE;
const TIMEOUT = 12000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// A logo URL carrying an expiry is worthless to store — it renders in review and 403s
// days later. Sprout's CDN paths are unsigned, but guard anyway: the field is theirs to
// change, and this pipeline has already been burned once by Rippling's signed URLs.
const EXPIRING = /[?&](Expires|X-Amz-Expires|Signature|X-Amz-Signature|Key-Pair-Id)=/i;

// Returns the job, MISSING for a real 404, or DROPPED when the request itself failed.
// Collapsing those last two is what makes a bad run invisible: a timed-out id looks
// exactly like an empty one, so a slice that loses 16% of its requests still reports a
// clean finish. Slice offset=2 did precisely that — 86,283 jobs against 102,731 for its
// sibling, and a re-probe found 4 of 24 live ids absent from the corpus.
const MISSING = Symbol('missing');
const DROPPED = Symbol('dropped');

async function fetchOnce(id) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(`https://api.usesprout.com/jobs/${id}`, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: ctl.signal,
    });
    if (res.status === 404) return MISSING;      // genuinely no job at this id
    if (!res.ok) return DROPPED;                 // 5xx / 429 — worth another try
    const j = await res.json();
    return j && j.id ? j : MISSING;
  } catch {
    return DROPPED;                              // timeout, socket reset, DNS blip
  } finally {
    clearTimeout(timer);
  }
}

// Retry only DROPPED. Retrying a 404 would triple the request count for no gain, since
// roughly a third of the band is genuinely empty.
async function getJob(id) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetchOnce(id);
    if (r !== DROPPED) return r;
    await new Promise(r2 => setTimeout(r2, 400 * (attempt + 1)));
  }
  return DROPPED;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return null; }
}

async function main() {
  // FILL=1 retries only the ids a previous run of this slice gave up on.
  const FILL = process.env.FILL === '1';
  let ids = [];
  if (FILL) {
    try {
      ids = fs.readFileSync(dropFile(), 'utf8').split('\n').map(x => parseInt(x, 10)).filter(Boolean);
    } catch { ids = []; }
    if (!ids.length) { console.log(`FILL offset=${OFFSET}: no recorded drops, nothing to do`); return; }
    console.log(`FILL offset=${OFFSET}: retrying ${ids.length} dropped ids`);
    fs.rmSync(dropFile(), { force: true });   // re-recorded below if they fail again
  } else {
    for (let id = LO + OFFSET; id <= HI; id += STRIDE) ids.push(id);
  }

  // Resume support: a 4-hour walk that dies at hour 3 must not start over.
  const prev = FILL ? null : loadState();
  let start = 0;
  if (prev && prev.stride === STRIDE && prev.offset === OFFSET && prev.lo === LO && prev.hi === HI) {
    start = prev.cursor || 0;
    if (start) console.log(`resuming at ${start}/${ids.length}`);
  } else if (fs.existsSync(OUT)) {
    // Slices append to one file; dedup happens at analysis time, so it is never truncated.
    console.log('note: existing sprout-companies.jsonl kept, appending');
  }

  const t0 = Date.now();
  let next = start, done = 0, hits = 0, withLogo = 0, expiring = 0, dropped = 0;
  const dropIds = [];
  let buf = [];

  const flush = () => {
    if (buf.length) { fs.appendFileSync(OUT, buf.join('\n') + '\n'); buf = []; }
    if (!FILL) fs.writeFileSync(stateFile(),
      JSON.stringify({ stride: STRIDE, offset: OFFSET, lo: LO, hi: HI, cursor: next }));
  };

  const worker = async () => {
    while (next < ids.length) {
      const j = await getJob(ids[next++]);
      done++;
      if (j === DROPPED) { dropped++; dropIds.push(ids[next - 1]); }   // a real hole
      else if (j !== MISSING) {
        hits++;
        if (j.companyLogo) {
          if (EXPIRING.test(j.companyLogo)) expiring++;
          else {
            withLogo++;
            buf.push(JSON.stringify({
              id: j.id, company: j.company, logo: j.companyLogo,
              url: j.postingUrl || null, industry: j.industry || null,
            }));
          }
        }
      }
      if (done % 2000 === 0) {
        flush();
        const s = (Date.now() - t0) / 1000;
        const rate = done / s;
        const left = (ids.length - next) / rate;
        console.log(`  ${done}/${ids.length - start} | ${hits} jobs | ${withLogo} logos | ` +
          (dropped ? `${dropped} dropped | ` : '') +
          `${rate.toFixed(0)} req/s | ETA ${(left / 60).toFixed(0)}m`);
      }
    }
  };

  await Promise.all(Array.from({ length: CONC }, worker));
  flush();

  const s = (Date.now() - t0) / 1000;
  console.log(`HARVEST stride=${STRIDE} offset=${OFFSET} | walked ${done} ids in ${(s / 60).toFixed(1)}m | ` +
    `jobs ${hits} | logos ${withLogo}` + (expiring ? ` | ${expiring} REJECTED as expiring` : '') +
    ` -> ${OUT}`);

  // Say it loudly. A slice that quietly loses ids reports a clean finish and poisons the
  // corpus with holes nobody looks for. Exit non-zero so a chained loop stops.
  if (dropped) {
    fs.writeFileSync(dropFile(), dropIds.join('\n') + '\n');
    console.log(`DROPPED ${dropped} ids (${(dropped / done * 100).toFixed(2)}%) after 4 retries ` +
      `— slice offset=${OFFSET} is INCOMPLETE; FILL=1 re-runs just these ${dropped}`);
    process.exit(4);
  }
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
