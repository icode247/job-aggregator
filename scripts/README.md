# `scripts/` — what each script is, and whether it is still used

85 files accumulated over six months. Most are one-off tools that did their job and were never
deleted. This document sorts them so a new maintainer knows what is load-bearing.

**How to read the tags**

| tag | meaning |
|---|---|
| **ACTIVE** | running right now, or launched by something that is. Do not delete. |
| **ON-DEMAND** | maintained and correct; run by hand when needed. |
| **DEAD** | the API, credential or account it depends on no longer works. |
| **SUPERSEDED** | something else does this job better. Kept only for reference. |
| **ONE-OFF** | a migration or repair that already ran. Historical. |
| **DEBUG** | throwaway diagnostics from a past investigation. |

Evidence used: what is in the process table, what `launch-local-crawlers.sh` and
`render-worker.js` reference, what `package.json` declares, last-commit dates, and the scripts'
own headers where they record a dead credential.

---

## Where the system actually runs

Two places, and it matters for knowing what is live:

- **This laptop** runs the crawler fleet, both dead-job pruners, and the description backfills,
  all started by `launch-local-crawlers.sh` at login. **When the laptop sleeps, all of it stops** —
  measured overnight, retirement drops from ~9,000/hour to ~200/hour.
- **Render** runs the API (`src/web.js`, branch `render-web`) and a background worker
  (`scripts/render-worker.js`, branch `render-deploy`). The worker is a 512MB starter instance
  and restarts 13–18 times a day under memory pressure — long-standing, self-healing, not new.

Postgres is on Heroku. Meilisearch is a private service on Render.

---

## ACTIVE — running continuously

| script | what it does |
|---|---|
| `launch-local-crawlers.sh` | Starts the whole local fleet at login: 11 crawler instances, 2 pruners, the backfills. **The entry point — read this first.** Sets `SYNC_ABSENCE_REMOVAL=1`, which arms automatic retirement. |
| `crawl-companies-local.js` | The crawler. One process per ATS group, 11 running. Fetches each company's board and calls `jobsRepo.syncForCompany`. |
| `prune-dead-jobs-local.js` | Dead-job pruner. Two instances split the corpus by id parity (`PARTITION_REMAINDER=0` and `1`). HTTP-checks 5,000 jobs a cycle and retires the confirmed-dead. |
| `local-backfill-descriptions.js` | Fills missing descriptions across all automatable platforms. |
| `backfill-desc-generic.js` | Same, but drives ONE platform to exhaustion. Currently looping on paylocity. |
| `backfill-comeet-desc.js` | Comeet-specific description backfill (its detail pages need special handling). |
| `render-worker.js` | The Render worker entry point. Runs company syncs, classification backfill, stale cleanup, demand crawl, and **Meili sync** — the last of which only works from Render, because Meilisearch is a private service. |
| `log-health.sh` | Hourly cron job → `~/job-board-health.log`. One line of board health. |
| `health-metrics.js` | The database half of `log-health.sh`. Not run directly. |
| `job-roles.js` | Shared 1,683-entry role vocabulary. **A library, not a script** — imported by the keyword-driven discovery and fetch tools. |

**Reading the health log.** `tail ~/job-board-health.log`. Two fields matter most:
- `fallbacks_1h` — searches that gave up on Meilisearch and hit Postgres. This is the mechanism
  that took the board down on 2026-08-20. Sustained non-zero is the real alarm.
- `absent3` — jobs about to be auto-retired. If it climbs steadily rather than drifting down, the
  absence signal has drifted and `SYNC_ABSENCE_REMOVAL` should be switched off.

---

## ON-DEMAND — maintained, run when needed

| script | when you would run it |
|---|---|
| `discover-jobvite.js` | Find Jobvite boards by probing slug guesses (HEAD + `redirect: manual`, ~300ms each, zero bandwidth). The template for cheap ATS discovery. |
| `import-jobvite-boards.js` | Import what the above confirmed. Takes the company name from Jobvite, never from the guess that found it. |
| `discover-comeet.js` | Comeet discovery via SERP + page-embedded token extraction. |
| `discover-workable-by-keyword.js` | Workable slug discovery by marketplace keyword search. Replaced manual Google dorking. |
| `discover-all-roles.js` | Drives the above across the whole `job-roles.js` vocabulary. Checkpointed. |
| `prune-dead-jobs-render.js` | Puppeteer pruner — renders pages to catch boards that return HTTP 200 while displaying "no longer accepting applications". **Shadow by default; needs `APPLY=1`.** Only ~1% of jobs need it, and 10 tabs will exhaust this laptop's memory. Use `TABS=4` and not while the crawlers are busy. |
| `prune-workday-dead.js` | One-off Workday sweep. Parked at a cursor; the rotating pruner covers Workday now. |
| `meili-backfill.js` | Rebuild the search index from Postgres. Read-only against the database. |
| `meili-init.js` | Create the index with its settings. Run once per new index. |
| `fetch-jobloo.js` | Bulk import from jobloo.co's public API. Shard by category or it degrades badly. |
| `fetch-liftmycv.js` | LiftMyCV public API. Still works — no credential needed. |
| `import-ats-slugs.js` | Seed companies from an external ATS-slug dump. |
| `import-ats-companies-csv.js` | Seed from the `ats-scrapers` tenant lists. |
| `sync-jobs-to-postgres.js` | Push local SQLite rows to Postgres. |
| `check-dead-jobs.js` | CLI for the dead-job checker. Useful for testing one URL by hand. |
| `dedup-ats-duplicates.js` | Deduplicate rows sharing `(ats, ats_slug)`. |
| `test-sync-batch.js` | Verifies the batched `syncForCompany` upsert. Worth running after touching sync. |

---

## DEAD — the credential or API no longer works

Do not debug these expecting them to run. Each is blocked on an account, not a bug.

| script | why |
|---|---|
| `fetch-lazyapply.js` | LazyApply proxies through **ScrapingDog**, whose quota is exhausted. Returns `403 {"error":"ScrapingDog API error"}` **even with a valid token** — the 403 is not an auth problem. |
| `fetch-wonsulting.js` | Cookie-based auth, exhausted / server cap. |
| `fetch-apify-ats.js` | Apify actor quota. |
| `fetch-fantastic-jobs.js` | Apify actor quota. |
| `discover-serp.js` | SERP API quota exhausted; ScrapingDog fallback also dead. |
| `backfill-workable-desc-proxy.sh` | Depends on the **IPRoyal** proxy account, dead as of 2026-08-08. |
| `drain-workable-proxy.sh` | Same. Its header records that Workable now blocks outright rather than rate-limiting. |
| `fetch-resumly.js`, `fetch-resumly-bulk.js`, `import-resumly-file.js`, `resumly-roles.js` | resumly.ai stopped producing 2026-07-30. Needs a fresh 24h JWT to revive. |
| `fetch-trueup.js` | Not in any active path; unverified since July. |

**Note on the BrightData key**: `BRIGHT_DATA_API_KEY` in `.env` returns `HTTP 407`.
`BRIGHT_DATA_API_KEY_STANDBY` works. Anything routed through the Web Unlocker is silently
failing until those are swapped.

---

## SUPERSEDED — something else does this better

| script | replaced by |
|---|---|
| `prune-dead-jobs.js` | `prune-dead-jobs-local.js` (partitioned, resumable, platform-aware). |
| `scrape-google-ats.js` | Slug probing (see `discover-jobvite.js`). Cheaper, more accurate, no scraping account. |
| `import-liftmycv.js` | `fetch-liftmycv.js`. |
| `backfill-classify.js`, `classify-experience-openai.js` | `src/tasks/backfill-classifications.js`, run by the worker. |
| `backfill-bamboohr-desc.js` | `backfill-desc-generic.js bamboohr`. |
| `crawl-allscm-jobs.js`, `scrape-allscm.js`, `scrape-paylocity.js` | Superseded by the paylocity adapter and the normal crawler. |
| `discover-wwr-companies.js` | Superseded by keyword discovery. |

---

## ONE-OFF — already ran, kept for history

`migrate-to-pg.js` · `migrate-oraclecloud.js` · `backfill-enrichment.js` · `backfill-salary.js` ·
`backfill-batched.js` · `refetch-paylocity-salary.js` · `refetch-personio-desc.js` ·
`reset-visa-classification.js` · `fix-workday-career-urls.js` · `import-breezy-csv.js` ·
`import-flexjobs-csv.js` · `import-bamboohr-dataset.js` · `import-ats-dataset.js` ·
`import-ats-companies-v2.js` · `import-remote-companies.js` · `extract-icims-oracle-bamboohr.js` ·
`scan-bamboohr-greenhouse.js` · `merge-companies.js` · `seed.js` ·
`run-backfills-overnight.sh` · `seed-index-overnight.sh`

`backfill-batched.js` is worth reading before any bulk UPDATE — its header records why a single
600k-row update had to be cancelled after 27 minutes.

---

## DEBUG — throwaway diagnostics

`debug-discovery.js` · `debug-fetchers.js` · `debug-fetchers2.js` ·
`diagnose-description-fetchers.js` · `diagnose-freeze.js` · `dry-run-guard.js` ·
`verify-fetcher-fixes.js` · `check-csv-companies.js` · `check-desc-backfill.js` ·
`test-backfill-apis.js` · `test-icims-api.js` · `test-icims-html.js` · `test-jazzhr.js` ·
`test-classify.js` · `test-worldwide.js`

All safe to delete. They reference schemas and failures from March–May and several no longer run.

---

## `logo-review/` — a separate pipeline

Its own multi-step workflow for sourcing and approving company logos (harvest → export → eyeball
→ approve → save). Not part of job ingestion. Several `sprout-*.js` files there are uncommitted
work in progress.

---

## Two rules worth keeping

**Anything that deletes rows runs in shadow mode first.** On 2026-08-25 a plausible rule
("retire jobs whose company synced after the job was last seen") looked like it would clear
~3,000,000 rows. HTTP-testing 60 of those candidates found **48 still alive**. Shipping it would
have deleted roughly 2.5 million live jobs. Removal is soft (`removed_at`), never `DELETE`.

**Never mass-restart the database clients.** Restarting all 11 crawlers at once pins the
40-connection Postgres limit and takes the live API down. Restart one at a time and wait for each
to come back.
