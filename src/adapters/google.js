/**
 * Google — google.com/about/careers/applications
 *
 * There is NO API. The old careers.google.com/api/v3/search endpoint is gone (404), v2 301s
 * away, and neither the listing nor the detail pages carry a single application/ld+json block —
 * checked 2026-08-25 on a 1.1MB detail page, zero structured data. So this is HTML parsing, and
 * the whole design question is what to anchor on.
 *
 * NOT THE CLASS NAMES. The markup is full of `VfPpkd-MlC99b`, `l103df`, `QJPWVe`, `Xsxa1e` —
 * Closure build hashes that change whenever Google ships a frontend build. A parser keyed on
 * those looks perfect today and silently returns zero rows next month, and zero rows is the most
 * dangerous possible output here: syncForCompany reads an empty set as "this employer closed
 * every job" and retires the board. So the anchors are the things Google cannot change without
 * changing the product:
 *
 *   1. the URL shape          href="jobs/results/{digits}-{slug}"   (their canonical job route)
 *   2. the accessibility label aria-label="Learn more about {Title}" (a11y requirement)
 *   3. the visible ownership   "Google | {Location}"                 (brand attribution)
 *
 * Measured on one listing page: 20 job hrefs, 20 aria-labels, 18 location strings — so 1 and 2
 * are exact and 3 is best-effort, which is why location is allowed to be null but title is not.
 *
 * AND IT FAILS LOUDLY. If a page returns HTML but yields no jobs, fetchJobs throws rather than
 * returning []. A thrown error leaves the existing jobs alone; an empty array deletes them.
 */
const { inferWorkplace, htmlToText, fetchJson, sleep } = require('./faang-common');
const logger = require('../logger');

const SITE = 'https://www.google.com/about/careers/applications';
const LIST = `${SITE}/jobs/results/`;
const PAGE_DELAY_MS = 700;
const MAX_PAGES = 200;      // 20/page -> 4,000 jobs; runaway-loop backstop
const DETAIL_CONCURRENCY = 4;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function getHtml(url) {
  const res = await fetch(url, { headers: { Accept: 'text/html', ...HEADERS }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Google HTTP ${res.status}`);
  return res.text();
}

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/**
 * One listing page -> [{ id, slug, title, location }].
 *
 * Titles come from the aria-label rather than the heading text because the heading sits behind a
 * hashed class while the label is required for the link to be accessible at all.
 */
function parseListing(html) {
  const out = [];
  const seen = new Set();

  // The anchor carries BOTH the href and the aria-label, in either order depending on build, so
  // the pair is captured from one tag rather than by zipping two independent lists — zipping
  // silently mismatches title to job the moment one page has 20 links and 19 labels.
  //
  // The href is `jobs/results/{id}-{slug}` OPTIONALLY followed by a query string: Google echoes
  // the listing's own paging param onto every card link, so the bare URL yields
  // `...-networking-technologies"` while `?page=1` yields `...-networking-technologies?page=1"`.
  // The first cut anchored on a closing quote straight after the slug and matched 20 links on a
  // saved page but ZERO on a live paged fetch — caught only because fetchJobs throws on an empty
  // parse instead of returning [].
  const anchorRe = /<a\b[^>]*?(?:href="jobs\/results\/(\d+)-([a-z0-9-]+)(?:[?#][^"]*)?"[^>]*?aria-label="Learn more about ([^"]+)"|aria-label="Learn more about ([^"]+)"[^>]*?href="jobs\/results\/(\d+)-([a-z0-9-]+)(?:[?#][^"]*)?")[^>]*>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const id = m[1] || m[5];
    const slug = m[2] || m[6];
    const title = decode(m[3] || m[4]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, slug, title: title || null, location: null });
  }

  // Locations appear as `Google | <span..><span..>Sunnyvale, CA, USA</span>`, in document order.
  // Assigned positionally ONLY when the counts match exactly — an 18-for-20 mismatch (which does
  // happen) would otherwise shift every location onto the wrong job, and a wrong location is
  // worse than none on a filter users trust.
  const locs = [];
  const locRe = /Google\s*\|\s*<span[^>]*>\s*<span[^>]*>([^<]+)</gi;
  let lm;
  while ((lm = locRe.exec(html)) !== null) locs.push(decode(lm[1]));
  if (locs.length === out.length) out.forEach((j, i) => { j.location = locs[i] || null; });

  return out;
}

/**
 * The ONLY headings that belong to the job itself. An allowlist, not a blocklist.
 *
 * A blocklist was the first attempt and it failed in a way worth recording: a Google detail page
 * carries a "related jobs" rail whose cards are also <h3>, so the description of a Technical
 * Program Manager posting opened with the titles and locations of eight OTHER jobs before
 * reaching its own qualifications. You cannot enumerate what to exclude when the excluded thing
 * is "any other job title" — but you can enumerate the four headings Google actually uses on a
 * posting, and anything else is not description.
 */
const JOB_SECTION_HEADINGS = /^(minimum qualifications|preferred qualifications|about the job|responsibilities|qualifications)$/i;

/**
 * Where the posting stops and the site's legal furniture starts. Everything from here on is
 * identical across the whole corpus, which is noise in the record and actively harms search
 * ranking by making every Google job look alike to the index.
 */
const DESC_TERMINATORS = [
  'Information collected and processed as part of your Google Careers profile',
  'Google is proud to be an equal opportunity',
  'To all recruitment agencies',
];

/**
 * Detail page -> { description, location }.
 *
 * Sections are taken from the visible copy headings Google puts on every posting — "Minimum
 * qualifications", "Preferred qualifications", "About the job", "Responsibilities". Those are
 * product text rather than build artefacts, so they survive a restyle.
 *
 * h3 AND h4, and the trailing colon is optional: the LISTING page renders these as
 * `<h4>Minimum qualifications</h4>` while the DETAIL page renders the same section as
 * `<h3>Minimum qualifications:</h3>`. The first cut matched only h4 and returned an empty
 * description for every detail page — parsing clean and yielding nothing, which is the failure
 * mode that is easiest to ship by accident.
 */
function parseDetail(html) {
  const sections = [];
  const sectionRe = /<h([34])[^>]*>([^<]{3,60})<\/h\1>\s*((?:(?!<h[1-4])[\s\S]){0,12000}?)(?=<h[1-4]|<\/main|$)/gi;
  let m;
  while ((m = sectionRe.exec(html)) !== null) {
    const heading = decode(m[2]).replace(/:\s*$/, '');
    if (!heading || !JOB_SECTION_HEADINGS.test(heading)) continue;
    let body = htmlToText(m[3]);
    if (!body) continue;
    for (const t of DESC_TERMINATORS) {
      const at = body.indexOf(t);
      if (at > 0) body = body.slice(0, at).trim();
    }
    if (body.length > 20) sections.push(`${heading}\n${body}`);
  }
  const description = sections.length ? sections.join('\n\n') : null;

  let location = null;
  const lm = /Google\s*\|\s*<span[^>]*>\s*<span[^>]*>([^<]+)</i.exec(html);
  if (lm) location = decode(lm[1]);

  return { description, location };
}

async function fetchJobs(slug) {
  const listings = [];
  const seen = new Set();
  let sawHtmlWithNoJobs = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    let html;
    try {
      html = await getHtml(`${LIST}?page=${page}`);
    } catch (err) {
      // A failed page mid-walk makes the set incomplete. Stop and report what we have as capped
      // rather than pretending the remaining pages were empty.
      logger.warn({ slug, page, err: err.message }, 'Google: listing page failed');
      break;
    }
    const batch = parseListing(html);
    if (!batch.length) {
      // Page 1 yielding nothing means the markup moved, not that Google stopped hiring.
      if (page === 1) sawHtmlWithNoJobs = true;
      break;
    }
    let added = 0;
    for (const l of batch) {
      if (seen.has(l.id)) continue;
      seen.add(l.id); listings.push(l); added++;
    }
    // Google keeps serving the last page's content past the end rather than 404ing, so an
    // all-duplicate page is the real terminator.
    if (added === 0) break;
    await sleep(PAGE_DELAY_MS);
  }

  if (sawHtmlWithNoJobs) {
    throw new Error('Google: listing page parsed to zero jobs — markup likely changed');
  }
  if (!listings.length) throw new Error('Google: no listings found');

  // Detail pages, for descriptions. mapLimit is not used here because each detail is an HTML
  // GET of ~1.1MB and running many at once is what gets this host rate-limited.
  const jobs = [];
  for (let i = 0; i < listings.length; i += DETAIL_CONCURRENCY) {
    const batch = listings.slice(i, i + DETAIL_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((l) => getHtml(`${SITE}/jobs/results/${l.id}-${l.slug}`).then(parseDetail))
    );
    for (let k = 0; k < batch.length; k++) {
      const l = batch[k];
      const d = settled[k].status === 'fulfilled' ? settled[k].value : null;
      const location = l.location || d?.location || null;
      jobs.push({
        external_id: `google_${l.id}`,
        title: l.title,
        department: null, // Google does not expose one on either page
        location,
        workplace_type: inferWorkplace({ title: l.title, location }),
        employment_type: null,
        description: d?.description || null,
        url: `${SITE}/jobs/results/${l.id}-${l.slug}`,
        posted_at: null, // no posted date anywhere in the markup; first_seen_at carries it
        raw_data: { google_job_id: l.id, slug: l.slug },
      });
    }
    await sleep(PAGE_DELAY_MS);
  }

  const missing = jobs.filter((j) => !j.description).length;
  if (missing) logger.warn({ slug, missing, total: jobs.length }, 'Google: postings without a description');

  return { jobs, meta: { companyName: 'Google', capped: false } };
}

module.exports = { fetchJobs, parseListing, parseDetail };
