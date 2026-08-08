# Logo review pipeline

Fills in `companies.logo_url` for companies that have none. Every batch ends with a **human
eyeball step** — a page of logo cards you scan and pick from — because automated logo scraping
returns the ATS vendor's own artwork, favicons, and random hero images often enough that
unattended saving would put junk on the board.

**Status:** ~28,053 companies reviewed so far (`data/logo/processed.txt`). Roughly **22,300 of
77,775** companies with live jobs still have no logo (~29%).

---

## The loop

Five steps. Steps 1–3 are mechanical, step 4 is you, step 5 writes.

### 1. Export a batch

```bash
node scripts/logo-review/export-batch.js 500          # own-domain companies
SHARED=1 node scripts/logo-review/export-batch.js 500 # ATS-host domains
```

Picks logo-less companies **ordered by live job count**, so the highest user-visible impact
comes first. Skips anything in `data/logo/processed.txt`.

Writes `data/logo/batch-companies.json` and `data/logo/batch-websites.csv`.

**`SHARED=1` matters.** ~16.5k companies have an ATS host as their `domain`
(`recruiting.paylocity.com`, `ats.rippling.com`, …). They have no own-domain page to scrape —
only their ATS careers page, which is a JS-rendered SPA. Restricted to the ATS that actually
publish a per-company logo: Workday `career_url`s in the DB are malformed (missing the `wdN`
subdomain, so DNS fails) and Workable/Comeet boards only ever show vendor art.

### 2. Scrape the logos

```bash
node scripts/logo-review/render-scrape.js data/logo/batch-companies.json data/logo/batch-logos.csv 8
```

Failed rows are retried at a third of the concurrency before the CSV is written. Navigation
timeouts are usually this machine being busy — the local crawler fleet runs six instances —
rather than a dead board: one batch lost 275 of 500 companies to timeouts at concurrency 8
and 253 of them scraped fine at 3. Without the retry they would have been marked reviewed by
step 5 having never been fetched. Drop the concurrency argument if the machine is loaded.

Renders each careers page in a headless browser and pulls the logo out of the **painted DOM** —
a static fetch sees only the ATS's own assets, because the company's uploaded logo exists only
after the page runs. One renderer covers every ATS, which beats reverse-engineering ten separate
branding APIs. Known ATS-owned assets are filtered out, otherwise every company on a given ATS
gets handed the same image.

Output CSV shape: `website,logo_url,logo_type,status`.

### 3. Build the review page

```bash
node scripts/logo-review/build-preview.js
```

Reads `batch-companies.json` + `batch-logos.csv`. Writes:
- `data/logo/batch-review.json` — the `id -> logo_url` map step 5 needs
- `data/logo/logo-preview.html` — the clickable page you review
- `data/logo/logo-preview-NNN.html` — the same page under a fresh, numbered path

**Open the numbered one.** The fixed filename is overwritten every batch, so a tab left
open from the previous round looks identical to the current one and its "Copy save-list"
button still yields the *old* ids — that happened twice in a row before the numbered copy
existed. The script prints the path to open.

It refuses outright if no company in the batch appears in the CSV. `render-scrape.js` only
writes on completion, so a killed run leaves the previous batch's file behind; building
from it yields no cards while step 5 still marks all 500 companies processed.

Images are **inlined as data URIs**. If the page is published as an Artifact it runs under a CSP
that blocks every external host, so a remote `<img src>` renders blank and gets rejected for the
wrong reason. It also sniffs magic bytes rather than trusting `Content-Type` — plenty of hosts
serve a good PNG as `application/octet-stream` (Paylocity's `GetLogoFileById` does it for about
half its images), and trusting the header silently dropped them from review.

### 4. Eyeball it — this is the human step

Open `data/logo/logo-preview.html` (locally, or publish it as an Artifact to review on another
device). Scan the cards and note the **ids you approve**.

What to reject: ATS vendor logos, favicons, generic building/people stock art, images that are
clearly a hero banner rather than a mark, anything unreadable at small size.

Save the approved ids to a file — any format works, every `#123` or bare number is picked up:

```
data/logo/approved.txt
```

### 5. Save

```bash
node scripts/logo-review/save-logos.js data/logo/approved.txt
```

Writes `logo_url` for the approved ids and marks the **whole batch** processed, so the ones you
rejected don't come back in a later batch.

---

## After saving: it propagates automatically

As of 2026-08-06 a Postgres trigger (`trig_companies_index_dirty`) marks the company whenever
`logo_url`, `company_name`, `domain` or `ats_slug` changes. The Meilisearch sync loop on the
Render worker (`job-aggregator-va`) then re-pushes that company's job documents within ~60s.

**Nothing extra to run.** Before that trigger existed, saving a logo updated Postgres and left
the search index serving the old value forever.

Requirement: the Render worker must be running. If it is suspended, changes still queue safely
in `companies.index_dirty_at` and ship when it comes back.

---

## `recover-dropped.js`

```bash
node scripts/logo-review/recover-dropped.js
```

One-off repair. The preview builder used to require an `image/*` Content-Type and a 220KB cap,
so roughly half of every Paylocity batch never became a card — those companies were marked
reviewed without ever being seen.

Walks the cached renders in `data/logo/shared*-full-logos.csv`, keeps only companies that are
**still** logo-less, and includes a company only when its logo would have **failed** under the
old rules but **succeeds** under the new ones. That distinction is deliberate: anything that
would have downloaded fine before was shown and deliberately rejected, and must not be put back
in front of the reviewer.

Writes the usual `batch-companies.json` / `batch-logos.csv` pair, so step 3 consumes it unchanged.

---

## Known limits

- **~23.6k companies on shared ATS-host domains are effectively unscrapeable** — no own-domain
  page, and their ATS shows only vendor art.
- **`logo.clearbit.com` is dead** (DNS gone), so the old domain-guess fallback returns nothing.
- Workday `career_url`s in the DB are malformed (missing `wdN` subdomain) and fail DNS.
