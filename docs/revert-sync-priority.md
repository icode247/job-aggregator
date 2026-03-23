# Sync Priority Mode — Revert Guide

**Date enabled:** 2026-03-23
**Reason:** We have enough companies inserted manually. Resources were shifted from crawling/discovery to sync (job fetching) to prioritize getting jobs for existing companies.

## What was changed

### 1. Crawl worker — DISABLED
**File:** `src/worker.js`
- Crawl queue, worker, and fanout completely removed from the main loop
- Workable marketplace crawl (every 6h) also disabled
- Crawl queue cleanup and shutdown hooks removed

### 2. Discovery worker — concurrency reduced
**File:** `src/queues/discovery.queue.js`
- Concurrency: `10` → `2`

**File:** `src/config.js`
- Rate limit: `50/min` → `10/min`

### 3. Sync worker — concurrency increased
**File:** `src/queues/sync.queue.js`
- Concurrency: `20` → `30`

## How to revert

### Re-enable crawl worker (`src/worker.js`)
1. Uncomment the `createCrawlQueue`/`createCrawlWorker` require
2. Uncomment the `crawlWorkableMarketplace` require
3. Restore `crawlQueue` and `crawlWorker` creation in `main()`
4. Restore `crawlWorker.on('completed', ...)` fanout listener
5. Restore crawl queue cleanup lines (`crawlQueue.clean(...)`)
6. Pass `crawlQueue` back to `registerSchedules(discoveryQueue, syncQueue, crawlQueue)`
7. Restore `fanoutCrawl` timeout: `setTimeout(() => fanoutCrawl(crawlQueue)..., 90000)`
8. Restore `crawlWorker.close()` and `crawlQueue.close()` in shutdown
9. Restore `runWorkableMarketplace` timer function

### Restore discovery concurrency
- `src/queues/discovery.queue.js` — change concurrency back to `10`
- `src/config.js` — change `DISCOVERY_RATE_LIMIT` max back to `50`

### Restore sync concurrency
- `src/queues/sync.queue.js` — change concurrency back to `20`

### Scheduler (`src/queues/scheduler.js`)
- The `if (crawlQueue)` guard is backwards-compatible — no change needed, it will just work once crawlQueue is passed again.
