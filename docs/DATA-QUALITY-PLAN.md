# Data Quality Plan — from "most jobs" to "best job board"

Status: proposal, nothing implemented.
All figures measured against Heroku `fastapply-board` Postgres on 2026-08-02.

---

## 1. The honest position

We win on coverage and lose on everything a user actually judges us by.

| Dimension | Us today | What a top player ships |
|---|---|---|
| Active postings | 2.67M | Indeed ~10M+, LinkedIn ~10M+ |
| Verified live in last 3 days | **16%** | effectively 100% — dead links get pulled |
| Has remote/hybrid/onsite flag | **~35%** | ~100%, it's the top filter |
| Has a posted date | **83%**, but 0% for some ATS | ~100%, recency is the default sort |
| Has salary | **~22%** | 40–60% and rising (pay-transparency laws) |
| Company has a usable logo | **~51%** | ~100% |
| Description renders as structured HTML | mixed; iCIMS (220k) is entity-garbled plaintext | ~100% |

Row count is not the moat. Nobody has ever chosen a job board because it had more
rows. They choose it because the listings are alive, filterable, and readable.
That is what this plan buys.

---

## 2. Root causes, measured

### R1 — The freeze trap (the big one)

**1,055,024 active jobs (39%) can never be refreshed and never be removed.**
Another 458,311 have `posted_at IS NULL` and escape every cleanup path.
Combined: ~1.5M of 2.67M active rows (57%) are permanently frozen.

The mechanism is a three-way interaction in `src/db/repositories/jobs.js`:

1. `jobs.js:285-289` — `syncForCompany` filters the adapter's incoming jobs down to
   `freshJobs` (posted within 30 days). Anything older is silently dropped from the
   incoming set.
2. Those same postings already exist in our DB from an earlier crawl or bulk import.
   Because they were dropped in step 1, they are not in `incomingIds`, so the diff
   logic wants to mark them removed.
3. `jobs.js:355-360` — the `skipRemoval` guard fires when more than 50% of existing
   jobs are missing from the incoming set, or when `freshJobs.length === 0`. For any
   company whose inventory is mostly >30 days old, this is *always* true.

Net effect: the rows are neither upserted (so `last_seen_at` freezes forever) nor
removed (so they stay `removed_at IS NULL` and render as live jobs). The guard that
exists to prevent accidental wipeouts has become the thing preserving a million
stale listings.

The evidence, unambiguous:

- **798,000 jobs** belong to companies synced within the last 12 hours where **not a
  single job row was touched**. Worst offenders: smartrecruiters 303k (2,886
  companies), greenhouse 259k (11,047 companies), oracle 59k, zoho 35k, ashby 33k.
- 1.82M jobs belong to companies in the active sync rotation, yet only 357,767 (20%)
  have `last_seen_at` inside 3 days.

Note what this rules out: the sync loop is **not** slow. It laps 53,490 of 61,494
rotating companies every 24 hours. Throughput is fine. The writes are being thrown
away.

Secondary leak: `src/worker.js:74` deletes stale jobs with
`WHERE posted_at IS NOT NULL AND posted_at < NOW() - INTERVAL '90 days'`. The
458,311 rows with `posted_at IS NULL` are exempt from this forever.

### R2 — The logo pipeline has a dead vendor in it

`logo.clearbit.com` **no longer resolves** (DNS gone; Clearbit's free Logo API is
shut down). The entire quality tier of `src/adapters/logo.js` is a silent no-op, so
every company falls through to Google favicons. Two bugs compound it:

- `logo.js:365` returns `googleFaviconUrl(logoDomain)` **even after every candidate
  came back as the 726-byte generic globe** — unusable globes are stored as logos.
- Workday bypasses `fetchLogoUrl()` entirely; `workday.js:203` constructs
  `/assets/logo` with no validation. Tested 4 live tenants: one returned
  `content-type: text/plain` at 71KB (the SPA shell) — a broken image on the board.

Of 70,873 companies: 24,168 no logo, 6,680 Google favicon, 4,138 unvalidated
Workday URLs, 57 stale Clearbit. **~49% have nothing usable.**

Compounding it, `classifyCompanyDomain()` guesses `{slug}.com` for most ATS. That is
wrong often enough to matter (`ebizcharge` is `.net`) and there is no verification
step, so a wrong guess produces a confidently wrong logo.

### R3 — Descriptions are present but mangled

Description null rate is ~1% for the majors, so **backfilling is not the fix —
extraction is.**

- **iCIMS (220k jobs)**: only **3% contain any HTML**. `icims.js:292` strips all tags
  from the JSON-LD fallback and never decodes entities, so the board renders a wall
  of text containing literal `&nbsp;`. Verified in production samples.
- **Taleo**: `taleo.js:177` falls back to `og:description` — a ~150-char meta blurb
  stored as if it were a job description.
- **SuccessFactors**: 8% of sampled descriptions contain `<script>`/cookie-banner
  markers — page chrome captured as content.
- **Workday regression**: 115 of the 400 most recent rows (29%) have a null
  description, against a 1% lifetime average. Recent crawls are degrading.
- **Comeet**: 52% null lifetime, **100% null across the newest 400** — fully broken.

### R4 — The filters users actually use are empty

| Field | Missing | Cause |
|---|---|---|
| `salary_min` | 72–100% per ATS | regex-scraped from description text only; structured ATS salary fields unused |
| `workplace_type` | 44–93% (Workday 59%, iCIMS 79%, Paylocity 93%) | `workday.js:186` hardcodes `null`; derivation runs only at sync time, and frozen rows never re-sync |
| `posted_at` | iCIMS 96%, Rippling 98%, Pinpoint 99%, JazzHR 94%, Zoho 78% | adapters don't parse it |
| `department` | 8–100% | not extracted for most ATS |

`extractWorkplaceType` / `extractEmploymentType` already exist and run in
`sync.queue.js:119-124` — they simply never reach the frozen rows. **Fixing R1
recovers a large share of R4 for free.**

### R5 — Phantom ATS taxonomy

6,388 jobs sit under 11 un-normalized aliases from bulk imports: `oraclecloud`
(3,078), `taleo_careersection`, `zohorecruit`, `icims2`, `grnhse`, `myworkdayjobs`,
`jworkable`, `taleo_rss`, `oraclepeoplesoft`, `taleo_selectminds`, `taleo`. All are
100% missing department and salary. None are in `findDueForSync`'s IN-list, so none
can ever sync, and none are applyable. 1,700+ companies sit in the same phantom
buckets with `last_synced_at IS NULL`.

### R6 — Coverage that exists but is switched off

`companies.js:61` restricts sync to 13 ATS. Paused: workable (145k jobs), rippling
(25k), pinpoint (19k), jazzhr (14k), comeet (6.5k), personio. Those ~210k jobs decay
untouched. Separately, **~24,000 companies have never been synced once** — bamboohr
3,641, workable 6,746, jazzhr 3,071, smartrecruiters 1,948, icims 1,710, workday
1,239, successfactors 1,154.

### R7 — Workday truncation and slug corruption

`workday.js:139` caps pagination at `offset < 5000`, so every tenant with more than
5,000 postings is silently truncated. Separately, many Workday rows have `ats_slug`
stored as literally `en-US` / `en-us` — the locale path segment was captured instead
of the tenant, which will break any re-sync or URL reconstruction for those rows.

---

## 3. The scoreboard (build this first)

Nothing below is trustworthy without a metric that moves. One materialized view,
refreshed hourly, exposed on `/health`:

```sql
CREATE MATERIALIZED VIEW quality_scoreboard AS
SELECT
  ats,
  count(*)                                                                    AS active,
  round(100.0*count(*) FILTER (WHERE last_seen_at > now()-interval '3 days')/count(*))  AS pct_verified_3d,
  round(100.0*count(*) FILTER (WHERE workplace_type IS NOT NULL)/count(*))    AS pct_workmode,
  round(100.0*count(*) FILTER (WHERE posted_at IS NOT NULL)/count(*))         AS pct_dated,
  round(100.0*count(*) FILTER (WHERE salary_min IS NOT NULL)/count(*))        AS pct_salary,
  round(100.0*count(*) FILTER (WHERE department IS NOT NULL)/count(*))        AS pct_dept
FROM jobs WHERE removed_at IS NULL GROUP BY ats;
```

Deliberately **not** in the view: anything requiring `length(description)`.
Detoasting descriptions across 2.5M rows kills the connection — it took down two
audit queries during this investigation. Description quality is sampled separately
via bounded per-ATS `LIMIT 400` probes.

Ship targets:

| Metric | Now | 30 days | 90 days |
|---|---|---|---|
| Verified live ≤3 days | 16% | 70% | 90% |
| Has workplace_type | ~35% | 85% | 95% |
| Has posted_at | 83% | 95% | 98% |
| Company logo usable | 51% | 85% | 95% |
| Description structured HTML | mixed | 95% | 98% |

---

## 4. Phased plan

### Phase 1 — Unfreeze the corpus (highest leverage by a wide margin)

Fixes R1. Touches ~1.5M rows. Nothing else in this document matters as much.

1. **Stop dropping old jobs from the incoming set.** Delete the `freshJobs` filter at
   `jobs.js:285-289`. Upsert *everything* the adapter returns so `last_seen_at`
   always refreshes. Age is a **query-time** concern, not an ingest-time one — the
   API should filter by `posted_at`, not the writer.
2. **Rewrite the `skipRemoval` guard.** The current >50%-missing heuristic conflates
   "partial API response" with "normal churn". Replace with an explicit signal:
   skip removal only when the adapter *threw* or returned zero rows while the
   company previously had a non-zero count. A 60% drop from a healthy 200-job
   response is real churn and must be honoured.
3. **Add a reconciliation pass.** When a sync completes successfully and touches zero
   existing rows while returning >0 incoming rows, the stored rows are from a dead
   `external_id` namespace (a bulk import that the adapter can't reproduce). Mark
   them removed. This is what clears the 798k orphan pool.
4. **Fix the NULL-`posted_at` retention leak** at `worker.js:74` — fall back to
   `first_seen_at` so undated rows still age out.
5. **One-time sweep**, run once and reviewed before it goes near production: expire
   rows with `last_seen_at` older than 30 days whose company syncs successfully.

Risk: this is the one change that can mass-delete live jobs. Non-negotiable
guardrails — dry-run mode reporting counts per ATS first, a hard ceiling on rows
expired per cycle, and a staging run against a Postgres fork before production.

Expected: verified-≤3-days goes 16% → ~70% on the next full lap, and a large chunk
of R4 fixes itself because unfrozen rows finally run through
`extractWorkplaceType`.

### Phase 2 — Filter coverage

1. **Structured salary before regex.** Greenhouse, Lever, Ashby, and SmartRecruiters
   all expose compensation objects that we currently ignore in favour of scraping
   the description. Read the structured field first, fall back to regex.
2. **`posted_at` for the 90%+ gaps.** iCIMS/Rippling/Pinpoint/JazzHR all carry
   `datePosted` in JSON-LD. Where genuinely absent, store `first_seen_at` and label
   it "listed since" in the UI — never fabricate a posted date.
3. **`workplace_type` for Workday** — `workday.js:186` hardcodes `null` despite
   Workday exposing remote flags in the posting payload.
4. **Backfill task** for the fields on rows that won't naturally re-sync soon.

### Phase 3 — Description fidelity

1. **One shared `sanitizeDescriptionHtml()`** in `src/utils/html.js`: allowlist
   structural tags (`p`, `ul`, `ol`, `li`, `br`, `strong`, `em`, `h2`-`h4`), decode
   HTML entities, strip `<script>`/`<style>`/cookie-banner chrome. Every adapter
   routes through it.
2. **iCIMS**: stop stripping tags at `icims.js:292`. Biggest single win — 220k jobs
   fixed by one adapter change.
3. **Taleo**: treat an `og:description`-only result as *insufficient* and queue for
   detail-page backfill rather than storing a meta blurb as the description.
4. **Comeet and Workday regressions**: both are live and worsening; diagnose against
   current endpoints, they are likely a payload-shape change.
5. **Quality gate at write time**: reject descriptions under 200 chars or matching
   junk markers; queue them for backfill instead of persisting garbage.

### Phase 4 — Logos

1. **Replace the dead Clearbit tier.** Options: self-host from company domains via
   `/favicon.ico` + apple-touch-icon + og:image at high resolution, or a paid logo
   API. Either way, **validate content-type and byte size before storing** — the
   existing `MIN_LOGO_BYTES` check must apply to *every* path, including Workday.
2. **Never store a generic globe.** Fix `logo.js:365` to return `null` when all
   candidates failed. `NULL` lets the UI render a clean monogram fallback; a globe
   is strictly worse than nothing.
3. **Verify guessed domains.** `classifyCompanyDomain()` guesses `{slug}.com`; add a
   resolution check before trusting it.
4. **Re-run for the ~35k companies** with no logo or a globe.

### Phase 5 — Taxonomy and coverage

1. Merge the 11 phantom ATS values into their canonical platforms; reconstruct slugs
   where recoverable, retire what isn't.
2. Fix the Workday `ats_slug = 'en-US'` corruption (R7).
3. Lift the Workday 5,000-posting cap.
4. Work the ~24,000 never-synced companies as a dedicated backlog queue rather than
   letting them compete in the round-robin, where they lose forever.
5. Re-enable paused platforms behind the proxy where they block (workable 403s).

### Phase 6 — What actually makes a rival

Everything above gets us to parity on hygiene. These are the differentiators:

1. **Deduplicate.** Staffing agencies (Aerotek et al.) post identical boilerplate
   across hundreds of locations. Cluster on normalized title + company + description
   shingle; collapse to one listing with a location list.
2. **Demote reposts.** A job relisted every 30 days to look fresh should not
   outrank a genuinely new posting.
3. **Rank on freshness × completeness.** A listing with salary, work mode, and a
   real description outranks a bare one. This makes data quality
   self-reinforcing rather than a chore.
4. **Show verification honestly.** "Verified live 2 hours ago" is a feature no
   aggregator does well, and after Phase 1 we can actually claim it.
5. **Apply-through.** Our real edge over Indeed is that we hold the ATS-native
   posting ID — we can drive an application, not just a link.

---

## 5. Sequencing

Phase 1 first, alone, verified before anything else starts. It is the only change
that can destroy data, it is the largest quality win available, and it silently
fixes part of Phases 2 and 4. Phases 2–4 can then run in parallel. Phase 6 needs a
clean corpus, so it comes last.

Explicitly deprioritised: **salary coverage**. It is mostly absent from source data,
so it needs inference rather than extraction, and it is the least tractable item
here. Chasing it before Phase 1 would be motion without progress.

---

## Appendix — verification queries

```sql
-- Freeze trap: should trend to zero after Phase 1
SELECT count(*) FROM jobs j JOIN companies c ON c.id=j.company_id
WHERE j.removed_at IS NULL AND c.last_synced_at > now()-interval '12 hours'
  AND j.last_seen_at < now()-interval '2 days';

-- Logo health
SELECT count(*) FILTER (WHERE logo_url IS NULL) no_logo,
       count(*) FILTER (WHERE logo_url LIKE '%gstatic.com/faviconV2%') favicon,
       count(*) FILTER (WHERE logo_url LIKE '%myworkdayjobs.com%/assets/logo') unvalidated
FROM companies;

-- Description quality, bounded sample (do NOT run unbounded — it drops the connection)
SELECT round(100.0*count(*) FILTER (WHERE description IS NULL OR length(description)<200)/count(*))
FROM (SELECT description FROM jobs WHERE ats='icims' AND removed_at IS NULL
      ORDER BY id DESC LIMIT 400) t;
```
