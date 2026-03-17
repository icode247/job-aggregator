# Burst Upgrade Plan — 24-Hour Throughput Boost

**Date:** 2026-03-14
**Goal:** Temporarily upgrade Heroku resources to 2x throughput, run for 24 hours, then downgrade and optimize code to fit within current tier.

---

## Phase 1: Upgrade Resources (before code deploy)

### Heroku CLI Commands

```bash
# Upgrade BOTH dynos to Standard-2x (Heroku requires matching types)
heroku ps:resize web=standard-2x worker=standard-2x --app fastapply-board

# Upgrade Redis to premium-1 (100MB, $30/mo prorated)
heroku addons:upgrade heroku-redis:premium-1 --app fastapply-board

# Upgrade Postgres to essential-1 (10GB, $9/mo prorated)
# REQUIRED: DB was at 205% of 1GB limit, Heroku revoked write permissions
heroku addons:upgrade heroku-postgresql:essential-1 --app fastapply-board
```

### Estimated Cost for 24 Hours

| Resource              | Plan         | Hourly Rate  | 24hr Cost | Current 24hr | Extra   |
|-----------------------|--------------|-------------|-----------|--------------|---------|
| Web dyno              | Standard-2x  | ~$0.069/hr  | $1.64     | $0.23        | +$1.41  |
| Worker dyno           | Standard-2x  | ~$0.069/hr  | $1.64     | $0.23        | +$1.41  |
| Redis                 | premium-1    | ~$0.042/hr  | $0.98     | $0.50        | +$0.48  |
| Postgres              | essential-1  | ~$0.013/hr  | $0.31     | $0.007       | +$0.14  |
| **Total extra cost**  |              |             |           |              | **~$4** |

---

## Phase 2: Deploy 2x Code Changes

### File: `src/config.js`

```
SYNC_RATE_LIMIT:      { max: 80, duration: 60000 }   → { max: 160, duration: 60000 }
DISCOVERY_RATE_LIMIT: { max: 5, duration: 60000 }     → { max: 10, duration: 60000 }
CRAWL_RATE_LIMIT:     { max: 3, duration: 60000 }     → { max: 6, duration: 60000 }
```

### File: `src/queues/sync.queue.js` (line 67)

```
concurrency: 12  →  concurrency: 24
```

### File: `src/queues/discovery.queue.js` (line 64)

```
concurrency: 2  →  concurrency: 4
```

### File: `src/crawlers/dictionary.js` (line 120)

```
const batchSize = 15  →  const batchSize = 25
```

### File: `src/crawlers/dictionary.js` — Fix unbounded array (line 119-142)

Replace `allResults` accumulation with length counter to stop memory leak:

```js
// BEFORE (leaks memory)
const allResults = [];
// ...
allResults.push(...hits);
// ...
return allResults;

// AFTER (memory-safe — hits already processed via onHits callback)
let totalHits = 0;
// ...
totalHits += hits.length;
// ...
return totalHits;
```

Note: The crawl queue already processes hits incrementally via `onHits`, then
calls `processDiscoveredSlugs(slugs, ...)` at the end with the returned array.
After this change, the final call in `crawl.queue.js` line 87 needs to be
skipped for dictionary strategy (it's already handled by `onHits`).

---

## Phase 3: Monitor During 24-Hour Run

```bash
# Watch for R14 memory errors (should be gone with 1GB dyno)
heroku logs --tail --app fastapply-board | grep -E "R14|R15|Error"

# Check Redis memory usage
heroku redis:info --app fastapply-board

# Check worker memory
heroku logs --tail --app fastapply-board | grep "Process running mem"
```

### Warning Signs to Watch

- **R14 errors** — still over memory, reduce concurrency
- **429 responses** — ATS rate limiting, especially Workable
- **Redis evicted keys** — Redis full, reduce retention or upgrade further

---

## Phase 4: Revert After 24 Hours (~2026-03-15 morning)

### Step 1: Deploy optimized code (BEFORE downgrading resources)

These are the permanent values designed to fit within Basic dyno (512MB) + premium-0 Redis (50MB):

#### `src/config.js`

```
SYNC_RATE_LIMIT:      { max: 50, duration: 60000 }    (down from 80)
DISCOVERY_RATE_LIMIT: { max: 5, duration: 60000 }     (keep)
CRAWL_RATE_LIMIT:     { max: 3, duration: 60000 }     (keep)
```

#### `src/queues/sync.queue.js`

```
concurrency: 5       (down from 12)
removeOnComplete: 5   (down from 10)
removeOnFail: 20      (down from 50)
```

#### `src/queues/discovery.queue.js`

```
concurrency: 2        (keep)
removeOnComplete: 5
removeOnFail: 20
```

#### `src/queues/crawl.queue.js`

```
removeOnComplete: 5
removeOnFail: 20
```

#### `src/crawlers/dictionary.js`

```
batchSize: 8          (down from 15)
pause: 750ms          (up from 500ms)
```

Keep the `allResults` memory fix from Phase 2 — that's permanent.

### Step 2: Downgrade resources (AFTER code deploy is live)

**Keep Postgres on Essential-1** — at 1.6GB+ data and 10 ATS platforms, the 1GB
Essential-0 limit is not sustainable. The $4/mo difference ($9 vs $5) is worth
avoiding the write-permission lockout we hit during the burst.

```bash
# Downgrade both dynos back to Basic
heroku ps:resize web=basic worker=basic --app fastapply-board

# Downgrade Redis back to premium-0
heroku addons:downgrade heroku-redis:premium-0 --app fastapply-board

# Postgres stays on essential-1 ($9/mo) — DO NOT downgrade
```

### Step 3: Verify

```bash
# Confirm no R14 errors with new settings
heroku logs --tail --app fastapply-board | grep "Process running mem"

# Confirm Redis is stable
heroku redis:info --app fastapply-board
```

---

## Summary

| Phase | When | Action | Cost Impact |
|-------|------|--------|-------------|
| 1 | Now | Upgrade dynos + Redis + Postgres | +~$4 for 24hrs |
| 2 | Now | Deploy 2x throughput code | — |
| 3 | 24hrs | Monitor | — |
| 4 | +24hrs | Deploy optimized code, downgrade dynos + Redis | Back to $38/mo |

### Post-Revert Monthly Cost

| Resource | Plan | Monthly Cost |
|----------|------|-------------|
| Web dyno | Basic | $7 |
| Worker dyno | Basic | $7 |
| Postgres | Essential-1 (keep) | $9 |
| Redis | Premium-0 | $15 |
| **Total** | | **$38/mo** |

**Permanent benefit:** Memory-optimized code, 10 ATS platforms, no R14 errors, no Postgres lockouts.
