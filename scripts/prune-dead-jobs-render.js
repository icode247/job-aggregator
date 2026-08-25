#!/usr/bin/env node
/**
 * Dead-job pruning for jobs the HTTP check CANNOT decide — by actually rendering them.
 *
 * THE GAP THIS FILLS. src/tasks/dead-job-check.js fetches the raw HTML. That works for a server-
 * rendered board, and for Workday and Oracle it now asks their JSON APIs instead. But a large
 * part of the corpus is neither: single-page apps that return HTTP 200 with an empty app shell
 * and only paint "this job is no longer accepting applications" after JavaScript runs. To a raw
 * fetch those look alive forever — which is exactly the experience of clicking a listing on the
 * board and being told the role is closed.
 *
 * Rendering is the only way to see what a user sees, so this script drives a real browser.
 *
 * SAFETY, BECAUSE THIS DELETES THINGS.
 *
 * SHADOW=1 is the DEFAULT. You must pass APPLY=1 to write anything. That is deliberate: on
 * 2026-08-25 a cheaper "jobs whose company synced after the job was last seen" rule looked like
 * it would retire ~3,000,000 rows, and HTTP-testing 60 of those candidates found 48 ALIVE — a
 * 16% true-dead rate. Acting on it unverified would have deleted roughly 2.5 million live jobs.
 * Nothing in this file removes a row on an inference. A row is retired only when a rendered page
 * SAYS it is closed, in words, or the platform's own API says the requisition is gone.
 *
 * `removed_at` is a soft removal — the board and the Meili index both read `removed_at IS NULL`,
 * so a retired job leaves the site immediately but the row survives and can be revived. No
 * DELETE is issued anywhere here.
 *
 * VERIFY=1 runs the control first: a sample of jobs the HTTP check says are ALIVE is pushed
 * through the renderer, and if any come back "dead" the detection is wrong and the run aborts
 * before touching anything.
 *
 * TWO PHASES, so the browser does as little as possible.
 *   1. checkUrl() — free, no browser. A DEAD verdict here is final and costs nothing.
 *      An "alive" verdict is NOT trusted: it only means HTTP 200 with no dead phrase in the RAW
 *      HTML, and on a single-page app the raw HTML is an empty shell.
 *   2. Render everything phase 1 did not kill. The browser is the arbiter, because it sees what
 *      a candidate sees.
 *
 * WHAT THE BROWSER SEES THAT A FETCH CANNOT. Measured 2026-08-25 on 89 jobs the HTTP check
 * confidently called ALIVE: one of them — zoho job 102767103 — renders "No longer accepting
 * applications" in plain sight while returning HTTP 200 with nothing incriminating in the raw
 * HTML. That is ~1% of a supposedly-healthy population, and against 5.2M live rows it is tens of
 * thousands of jobs that no status-code check will ever find. Those are the ones a user clicks.
 *
 * COOKIE BANNERS ARE NOT JOB STATUS. The same run flagged five pinpoint jobs dead because their
 * cookie-policy table contains "As soon as browser window is closed" — five false positives for
 * one true find. Hence two rules that are not optional: consent/cookie/nav regions are stripped
 * from the DOM before the text is read, and every phrase in the list is a sentence fragment,
 * never a loose word like "expired" or "is closed".
 *
 * Workday is the exception worth knowing: its dead postings render an EMPTY body, so the browser
 * learns less than the CXS API call. The <200-char guard returns UNCERTAIN there rather than
 * dead, which is why that guard exists.
 *
 * CANDIDATE ORDER. Jobs whose company has synced successfully since the job was last seen are
 * checked first. Measured 2026-08-25: those are dead at 16% versus 2% for everything else — an
 * 8x enrichment. It is an ordering heuristic ONLY. It never decides anything.
 *
 * MEMORY, for an 8GB machine running the crawler fleet alongside this.
 *   - one browser, TABS pages reused in a pool (default 10)
 *   - images, media, fonts and stylesheets are aborted at the network layer, which is where the
 *     bulk of a page's memory goes; we only need text
 *   - pages are recycled every RECYCLE_PAGES loads because renderer memory creeps
 *   - the browser is fully restarted every RESTART_AFTER checks as a hard backstop
 *
 * Usage:
 *   SHADOW run (writes nothing, prints what it would retire):
 *     DATABASE_URL=... node scripts/prune-dead-jobs-render.js
 *   Prove the detector first, then arm it:
 *     VERIFY=1 DATABASE_URL=... node scripts/prune-dead-jobs-render.js
 *     APPLY=1  DATABASE_URL=... node scripts/prune-dead-jobs-render.js
 *
 * Env: LIMIT (candidates per batch, default 500) BATCHES (0 = until exhausted)
 *      TABS (default 10) ATS (comma list, restrict to platforms) APPLY=1 VERIFY=1
 */
const puppeteer = require('puppeteer');
const { DEAD_INDICATORS, checkUrl, runWithConcurrency } = require('../src/tasks/dead-job-check');
const { query, closeDb } = require('../src/db/connection');

const APPLY = process.env.APPLY === '1';
const VERIFY = process.env.VERIFY === '1';
const LIMIT = parseInt(process.env.LIMIT || '500', 10);
const BATCHES = parseInt(process.env.BATCHES || '0', 10);
const TABS = Math.max(1, Math.min(parseInt(process.env.TABS || '10', 10), 16));
const ATS_FILTER = (process.env.ATS || '').split(',').map((s) => s.trim()).filter(Boolean);
const NAV_TIMEOUT_MS = parseInt(process.env.NAV_TIMEOUT_MS || '25000', 10);
const RECYCLE_PAGES = 25;
const RESTART_AFTER = 400;

// Rendered-page phrases. These only appear AFTER JavaScript has run, which is precisely why the
// raw-HTML checker cannot see them — it is looking at an empty app shell.
//
// EVERY PHRASE HERE IS A FULL SENTENCE FRAGMENT, NEVER A LOOSE WORD. That rule was written in
// blood: a first pass matched the substring "is closed" and flagged five pinpoint jobs as dead
// because their COOKIE POLICY TABLE contains "As soon as browser window is closed". Five false
// positives for one true find. "expired", "not found", "unavailable" and "is closed" are all
// words that live happily in cookie notices, session-timeout copy and nav furniture, so none of
// them can stand alone. If a phrase could plausibly appear on a page that is still hiring, it
// does not belong in this list.
const RENDERED_DEAD_PHRASES = [
  ...DEAD_INDICATORS,
  'no longer accepting applications',
  'not accepting applications',
  'we are no longer accepting',
  'this job is no longer',
  'this position is no longer available',
  'this position has been filled',
  'this job posting has been closed',
  'this requisition has been closed',
  'this posting is no longer active',
  'this opportunity is no longer available',
  'applications for this position are closed',
  'this vacancy is closed',
  'this role is no longer open',
  'the position you are looking for',
  'this job has expired',
  'job posting expired',
];

// Phrases that mean "the page failed", NOT "the job closed". Treating these as dead is how a
// rate-limit or a bot wall turns into mass deletion of live jobs.
const NOT_EVIDENCE = [
  'access denied', 'forbidden', 'are you a robot', 'captcha', 'cloudflare',
  'rate limit', 'too many requests', 'temporarily unavailable', 'service unavailable',
  'enable javascript', 'please enable', 'checking your browser', 'ddos protection',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ browser pool */

async function launch() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',      // /dev/shm is small; without this Chrome crashes under load
      '--disable-gpu',
      '--no-zygote',
      '--disable-background-networking',
      '--disable-extensions',
      '--disable-sync',
      '--mute-audio',
      '--js-flags=--max-old-space-size=256',
    ],
  });
}

/**
 * Abort everything that is not the document or its scripts.
 *
 * The page has to RUN JavaScript — that is the whole point — but it never has to paint. Images,
 * video, fonts and stylesheets are the bulk of a modern job page's memory and none of them can
 * carry the words "no longer accepting applications". On an 8GB box shared with eleven crawlers
 * this is the difference between ten workable tabs and thrashing.
 */
async function armPage(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    if (type === 'image' || type === 'media' || type === 'font' || type === 'stylesheet') {
      req.abort().catch(() => {});
    } else {
      req.continue().catch(() => {});
    }
  });
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
}

/**
 * Render one URL and decide.
 *
 * Returns { alive: true|false|null, reason }. null means UNCERTAIN and must never be pruned —
 * a nav timeout, a bot wall and a 5xx all land here on purpose.
 */
async function renderCheck(page, url) {
  let res;
  try {
    res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  } catch (err) {
    return { alive: null, reason: `render nav ${err.name === 'TimeoutError' ? 'timeout' : err.message.slice(0, 40)}` };
  }
  if (!res) return { alive: null, reason: 'render no response' };

  const status = res.status();
  if (status === 404 || status === 410) return { alive: false, reason: `render HTTP ${status}` };
  if (status >= 400) return { alive: null, reason: `render HTTP ${status}` };

  // Let the SPA paint. networkidle would be more correct but is far slower and many of these
  // pages keep a socket open forever; a short settle after DOMContentLoaded is enough for the
  // "closed" banner, which is rendered from the first data response.
  await sleep(1200);

  // Read the page as a CANDIDATE would, minus the furniture.
  //
  // Cookie banners, consent tables, privacy dialogs and nav chrome are not job status, but they
  // are full of words that look like it — a pinpoint cookie table saying "As soon as browser
  // window is closed" was enough to flag five live jobs dead. Those regions are removed from the
  // DOM copy before the text is read, so they can never be evidence of anything.
  let text = '';
  try {
    text = await page.evaluate(() => {
      const JUNK = [
        '[id*="cookie" i]', '[class*="cookie" i]', '[id*="consent" i]', '[class*="consent" i]',
        '[id*="gdpr" i]', '[class*="gdpr" i]', '[aria-label*="cookie" i]',
        '[id*="onetrust" i]', '[class*="onetrust" i]', '#onetrust-banner-sdk',
        'nav', 'header', 'footer', 'script', 'style', 'noscript',
      ];
      // Operate on a detached clone so the live page is never mutated — a page we may still be
      // navigating should not be edited underneath itself.
      const clone = document.body ? document.body.cloneNode(true) : null;
      if (!clone) return '';
      for (const sel of JUNK) {
        let nodes = [];
        try { nodes = clone.querySelectorAll(sel); } catch { continue; }
        nodes.forEach((n) => n.remove());
      }
      return (clone.innerText || clone.textContent || '').slice(0, 20000);
    });
  } catch (err) {
    return { alive: null, reason: `render read failed: ${err.message.slice(0, 40)}` };
  }
  const lower = text.toLowerCase();

  // A near-empty body means the render did not complete, not that the job is gone.
  if (lower.trim().length < 200) return { alive: null, reason: 'render produced almost no text' };

  // Bot walls and outages first — they must never be read as evidence of closure.
  for (const p of NOT_EVIDENCE) {
    if (lower.includes(p)) return { alive: null, reason: `render blocked/unavailable (${p})` };
  }

  for (const p of RENDERED_DEAD_PHRASES) {
    if (lower.includes(p.toLowerCase())) return { alive: false, reason: `rendered: "${p}"` };
  }

  return { alive: true, reason: null };
}

/* ------------------------------------------------------------------ candidates */

/**
 * Candidate query, ordered by the enrichment signal.
 *
 * NO `ORDER BY` on a column without a serving index — that shape has blown the statement timeout
 * on this table repeatedly (all four worker loops, the workday sweep, the description backfill).
 * The ordering here is done in JS on an already-bounded id window instead.
 */
async function fetchCandidates(cursor, limit) {
  const atsClause = ATS_FILTER.length
    ? ` AND j.ats IN (${ATS_FILTER.map((a) => `'${a.replace(/'/g, "''")}'`).join(',')})` : '';
  const { rows } = await query(
    `SELECT j.id, j.url, j.ats, j.last_seen_at, c.last_synced_at, c.status
       FROM jobs j JOIN companies c ON j.company_id = c.id
      WHERE j.id > ? AND j.id <= ?
        AND j.removed_at IS NULL AND j.url IS NOT NULL${atsClause}
      LIMIT ?`,
    [cursor, cursor + 400000, limit * 3]
  );
  // Enriched first: 16% dead vs 2% (measured). Ordering only — it decides nothing.
  const score = (r) => {
    if (!r.last_synced_at || !r.last_seen_at) return 0;
    return new Date(r.last_synced_at) - new Date(r.last_seen_at) > 3600 * 1000 ? 1 : 0;
  };
  return rows.sort((a, b) => score(b) - score(a)).slice(0, limit);
}

async function retire(ids) {
  const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let i = 0; i < sorted.length; i += 500) {
    await query(
      `UPDATE jobs SET removed_at = NOW() WHERE id IN (
         SELECT id FROM jobs WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE
       )`,
      [sorted.slice(i, i + 500)]
    );
    if (i + 500 < sorted.length) await sleep(250);
  }
}

/* ------------------------------------------------------------------ run */

async function runPool(browser, jobs, onResult) {
  const pages = [];
  for (let i = 0; i < Math.min(TABS, jobs.length); i++) {
    const p = await browser.newPage();
    await armPage(p);
    pages.push({ page: p, loads: 0 });
  }
  let idx = 0;
  await Promise.all(pages.map(async (slot) => {
    while (idx < jobs.length) {
      const job = jobs[idx++];
      const verdict = await renderCheck(slot.page, job.url);
      onResult(job, verdict);
      slot.loads++;
      // Renderer memory creeps across loads; a fresh page is cheaper than a swapping machine.
      if (slot.loads >= RECYCLE_PAGES) {
        try { await slot.page.close(); } catch { /* already gone */ }
        slot.page = await browser.newPage();
        await armPage(slot.page);
        slot.loads = 0;
      }
    }
  }));
  for (const s of pages) { try { await s.page.close(); } catch { /* ignore */ } }
}

/**
 * Control run. Render jobs that are INDEPENDENTLY known to be live, and treat any "dead" verdict
 * as a false positive that blocks arming.
 *
 * "Independently" is the whole difficulty. The first version of this control sampled jobs the
 * HTTP CHECK called alive — which is circular, because the entire premise of this script is that
 * "HTTP says alive" is unreliable. It duly failed on zoho job 123591525, reported as a false
 * positive: HTTP 200, no dead phrase in the raw HTML, and the rendered page reading "No longer
 * accepting applications" above a posting last seen three months ago. The detector was right and
 * the control was wrong, which is the worst way for a safety gate to fail — it blocks correct
 * behaviour and would have been "fixed" by loosening the detector.
 *
 * The honest control is the ADAPTER, not the HTTP check. A job whose company synced within the
 * last few hours and which still has absent_syncs = 0 was listed on the employer's own board by
 * that employer's own API, minutes ago. If the renderer calls one of those dead, the detection
 * really is broken.
 */
async function verifyDetector(browser) {
  console.log('VERIFY: sampling jobs an adapter listed within the last few hours...');
  const { rows: control } = await query(
    `SELECT j.id, j.url, j.ats
       FROM jobs j JOIN companies c ON j.company_id = c.id
      WHERE j.removed_at IS NULL
        AND j.url IS NOT NULL
        AND j.absent_syncs = 0
        AND j.last_seen_at > NOW() - INTERVAL '6 hours'
        AND c.last_synced_at > NOW() - INTERVAL '6 hours'
      LIMIT 40`
  );
  if (!control.length) { console.log('VERIFY: no control jobs found — cannot prove safety'); return false; }

  let falsePositives = 0;
  await runPool(browser, control, (job, v) => {
    if (v.alive === false) {
      falsePositives++;
      console.log(`  FALSE POSITIVE  job=${job.id} ats=${job.ats} ${v.reason}`);
      console.log(`     ${job.url.slice(0, 110)}`);
    }
  });
  console.log(`VERIFY: ${control.length} known-live jobs rendered, ${falsePositives} false positives`);
  return falsePositives === 0;
}

(async () => {
  console.log(`${APPLY ? 'ARMED (will set removed_at)' : 'SHADOW (writes nothing)'} — tabs=${TABS} limit=${LIMIT}`
    + (ATS_FILTER.length ? ` ats=${ATS_FILTER.join(',')}` : ''));

  let browser = await launch();
  let checkedSinceRestart = 0;

  try {
    if (VERIFY) {
      const ok = await verifyDetector(browser);
      if (!ok) { console.error('VERIFY FAILED — detector produces false positives, refusing to continue'); process.exit(1); }
      if (!APPLY) { console.log('\nverify passed. Re-run with APPLY=1 to arm.'); process.exit(0); }
    }

    const { rows: [{ hi }] } = await query('SELECT MAX(id) AS hi FROM jobs');
    const maxId = Number(hi);
    let cursor = parseInt(process.env.START_ID || '0', 10);
    let batch = 0, totChecked = 0, totDead = 0, totAlive = 0, totUnc = 0;
    const started = Date.now();

    while ((BATCHES === 0 || batch < BATCHES) && cursor < maxId) {
      const jobs = await fetchCandidates(cursor, LIMIT);
      cursor += 400000;
      if (!jobs.length) continue;

      // Phase 1 — free. No browser.
      // Phase 1 exists ONLY to skip work, never to clear a job. A "dead" verdict here is free
      // and final. EVERYTHING ELSE GETS RENDERED — including the jobs checkUrl calls alive.
      //
      // That last part is the entire reason this script exists and the first version got it
      // backwards: it trusted `alive: true` and never opened a tab for those. But `alive: true`
      // just means "HTTP 200 and no dead phrase in the RAW HTML", and on a single-page app the
      // raw HTML is an empty shell — the words "No longer accepting applications" are painted by
      // JavaScript afterwards. Verified 2026-08-25: zoho job 102767103 returns 200, checkUrl
      // calls it alive, and the rendered page says "No longer accepting applications" in plain
      // sight. Skipping those is skipping the whole problem.
      const dead = [];
      const needsRender = [];
      await runWithConcurrency(jobs, 8, async (j) => {
        const r = await checkUrl(j.url);
        if (r.alive === false) dead.push({ id: j.id, reason: r.reason, ats: j.ats });
        else needsRender.push(j);   // alive OR undecided — the browser is the arbiter
      });
      const httpDead = dead.length;

      // Phase 2 — render only the undecided.
      let renderAlive = 0, renderUnc = 0;
      if (needsRender.length) {
        await runPool(browser, needsRender, (job, v) => {
          if (v.alive === false) dead.push({ id: job.id, reason: v.reason, ats: job.ats });
          else if (v.alive === true) renderAlive++;
          else renderUnc++;
        });
      }

      if (dead.length && APPLY) await retire(dead.map((d) => d.id));

      batch++;
      totChecked += jobs.length; totDead += dead.length; totAlive += renderAlive; totUnc += renderUnc;
      checkedSinceRestart += needsRender.length;
      const mins = (Date.now() - started) / 60000;
      console.log(
        `[${new Date().toISOString()}] batch ${batch} checked=${jobs.length} `
        + `dead=${dead.length} (http=${httpDead} rendered=${dead.length - httpDead}) `
        + `alive=${renderAlive} uncertain=${renderUnc} | total dead=${totDead}/${totChecked} `
        + `${Math.round(totChecked / Math.max(mins, 0.01))}/min cursor=${cursor}`
      );
      if (!APPLY && dead.length) {
        for (const d of dead.slice(0, 5)) console.log(`    would retire job=${d.id} ats=${d.ats} — ${d.reason}`);
      }

      // Hard memory backstop: a long-lived Chrome creeps regardless of page recycling.
      if (checkedSinceRestart >= RESTART_AFTER) {
        // Reassign the binding — Object.assign onto a Browser does NOT replace it, it just
        // copies enumerable props onto a closed instance and every later newPage() throws.
        try { await browser.close(); } catch { /* ignore */ }
        checkedSinceRestart = 0;
        console.log('  restarting browser (memory backstop)');
        browser = await launch();
      }
      await sleep(1500); // breathing room for the crawlers' sockets and the API's database
    }

    console.log(`\ndone: checked=${totChecked} dead=${totDead} alive=${totAlive} uncertain=${totUnc}`
      + (APPLY ? '' : '  (SHADOW — nothing was written)'));
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
    await closeDb();
  }
  process.exit(0);
})().catch((err) => { console.error('fatal:', err.message); process.exit(1); });
