# job-aggregator

A job board backend: crawls applicant-tracking systems (ATS) directly, normalises what it finds
into one schema, and serves it through a search API. ~5.1M live jobs across ~88k companies as of
2026-08-29.

The corpus comes from **talking to ATS APIs directly** — Greenhouse, Workday, Lever, Ashby,
Jobvite and ~20 more — not from scraping search engines or paying a scraping service. That is why
it is large and costs nothing per job.

---

## Layout

```
src/
  adapters/       one module per ATS. Each exports fetchJobs(slug) -> { jobs, meta }
  api/            Express routes, auth middleware, the search endpoint
  db/             connection, schema/migrations, repositories
  tasks/          long-running work: description backfill, dead-job pruning, Meili sync
  utils/          shared helpers (location resolution, URL parsers, proxy, logging)
scripts/          operational tooling — see scripts/README.md
data/             seed company lists (input files, not runtime state)
docs/             design notes
```

**Start with `scripts/README.md`.** It documents what runs where, how to start it, and the
operational rules that are not obvious from the code.

---

## Where it runs

| piece | where | branch |
|---|---|---|
| API (`src/web.js`) | Render web service | `render-web` |
| Background worker (`scripts/render-worker.js`) | Render worker | `render-deploy` |
| Crawler fleet, dead-job pruners, backfills | **a laptop**, started by `scripts/launch-local-crawlers.sh` | `wip-local-tooling` |
| Postgres | Heroku (`fastapply-board`), 40-connection cap | — |
| Meilisearch | Render private service | — |

Two consequences worth knowing before you touch anything:

- **Ingestion runs on a laptop.** When it sleeps, crawling and pruning stop — measured, job
  retirement drops from ~9,000/hour to ~200/hour.
- **Meilisearch is a private service**, reachable only from inside Render. Search index syncing
  cannot run locally.

---

## Getting started

```bash
npm install
cp .env.example .env          # then fill in DATABASE_URL at minimum
npm run migrate               # create/upgrade the schema
npm run start:web             # API on $PORT (default 3000)
```

`.env.example` lists every variable with a note on which are required.

### Reading data without a full setup

Everything needs `DATABASE_URL`. Most operational scripts take it inline:

```bash
DATABASE_URL="postgres://..." NODE_ENV=production node scripts/<script>.js
```

`NODE_ENV=production` matters — it enables TLS on the Postgres connection, which Heroku requires.

---

## How the pieces fit

**Ingestion.** `scripts/crawl-companies-local.js` claims companies that are due, calls the right
adapter, and hands the results to `jobsRepo.syncForCompany`. Adding a new ATS means writing one
adapter and registering it in `src/adapters/index.js` and `src/utils/supported-ats.js`.

**Job removal** happens two ways:
1. *At sync time* — a job missing from **3 consecutive successful syncs** is retired
   (`absent_syncs` counter, armed by `SYNC_ABSENCE_REMOVAL=1`). No HTTP, no cost.
2. *By the pruner* — `scripts/prune-dead-jobs-local.js` HTTP-checks jobs and retires the
   confirmed-dead. Workday and Oracle are checked against their JSON APIs because their pages
   return HTTP 200 for dead postings.

Removal is always **soft** (`removed_at` timestamp), never `DELETE`. The board and the search
index both read `WHERE removed_at IS NULL`.

**Search.** `/api/jobs` queries Meilisearch and falls back to Postgres if the index is
unavailable. A Postgres fallback is much slower and is the failure mode that has taken the board
down before — watch `fallbacks_1h` in the health log.

**The search index** is kept current by a Postgres outbox: a trigger sets `index_dirty_at` on any
row whose indexed fields change, and `src/tasks/meili-sync.js` ships those rows every 60s.

---

## Monitoring

An hourly cron writes one line to `~/job-board-health.log` on the crawler machine:

```bash
tail ~/job-board-health.log
```

| field | what it means |
|---|---|
| `fallbacks_1h` | searches that gave up on Meilisearch and hit Postgres. **The alarm.** Sustained non-zero needs attention. |
| `absent3` | jobs about to be auto-retired. Should drift down; a steady climb means the absence signal has drifted. |
| `retired_1h` | jobs removed in the last hour. Healthy is thousands. |
| `meili[p50/p90]` | search latency. p90 in the tens of ms is normal. |

---

## Conventions worth following

**Anything that deletes rows runs in shadow mode first.** On 2026-08-25 a plausible retirement
rule looked like it would clear ~3,000,000 rows; HTTP-testing 60 of those candidates found **48
still alive**. Shipping it would have deleted ~2.5M live jobs.

**Never mass-restart the database clients.** Restarting all 11 crawlers at once pins the
40-connection Postgres limit and takes the live API down. One at a time.

**No `ORDER BY` on an unindexed column against `jobs`.** The table is ~28GB. That shape has blown
the statement timeout repeatedly — walk primary-key ranges instead.

**Comments explain *why*, especially where the obvious approach was tried and failed.** Much of
this codebase's value is in those notes; several of them exist because a plausible-looking change
caused an outage.

---

## Known issues

- The Render worker is a 512MB starter instance running six jobs; it OOMs and self-restarts
  13–18 times a day. Long-standing, not a regression.
- `BRIGHT_DATA_API_KEY` returns HTTP 407 — `BRIGHT_DATA_API_KEY_STANDBY` works. Anything routed
  through the BrightData Web Unlocker fails silently until they are swapped.
- Workable descriptions have no working path: it IP-blocks, and the IPRoyal proxy account died
  2026-08-08.
- `taleo`, `oracle`, `oraclecloud`, `icims` and `successfactors` account for ~94% of the missing
  descriptions. They have working fetchers but no apply automation, so they are deliberately
  excluded from the backfill (`BACKFILL_NO_AUTOMATION_ATS=1` enables them).
