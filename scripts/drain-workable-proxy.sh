#!/usr/bin/env bash
# One-time drain of apply.workable.com (direct per-company API) through Bright Data's
# Web Unlocker.
#
# WHY NOT THE IPROYAL PATH THIS SCRIPT USED TO TAKE
# Workable no longer merely rate-limits per IP — measured 2026-08-08, the v3 jobs API returned
# 429 on 12/12 real boards from a clean residential IP, instantly and with no retry-after, and
# the HTML board fallback is an SPA shell carrying no job data. Rotating addresses is not enough
# when the endpoint blocks outright. Through Web Unlocker the same 8 boards returned 8/8.
# (The IPRoyal account is also dead as of that date, as is ScrapingDog's quota.)
#
# BILLING — Web Unlocker bills PER REQUEST, not per GB. The adapter makes 2 calls per company
# (jobs + the widget that supplies company name and logo). Routing is restricted to
# apply.workable.com by BD_ROUTE_HOSTS inside src/utils/brightdata-proxy.js so nothing else can
# quietly spend the plan.
#
# SKIP_SLUG_LIKE drops the `wjb_<uuid>` rows: 5,655 of workable's 12,848 companies carry
# pseudo-slugs from marketplace keyword discovery which are not real account names and 404
# forever. Crawling them costs money to learn nothing. That leaves ~6.4k real slugs, so a full
# pass is ~13k requests rather than ~16k. Resolving those pseudo-slugs to real account names is
# separate work, and until it happens that inventory is not reachable through this path.
#
# STALE_MIN=1440 (24h) is the cost control: every workable company is due now, so this drains
# the backlog once, retries what errored, then IDLES instead of re-billing on a refresh loop.
#
# Stop anytime: kill $(cat /tmp/crawl-E.pid) && pkill -f 'ATS=workable'
set -u
cd "$(dirname "$0")/.."
export DATABASE_URL="$(heroku config:get DATABASE_URL -a fastapply-board 2>/dev/null)"
export NODE_ENV=production
[ -z "$DATABASE_URL" ] && { echo "FATAL: no DATABASE_URL"; exit 1; }

if [ -f /tmp/crawl-E.pid ] && kill -0 "$(cat /tmp/crawl-E.pid)" 2>/dev/null; then
  echo "E already running (pid $(cat /tmp/crawl-E.pid)). Stop it first: kill \$(cat /tmp/crawl-E.pid)"; exit 0
fi

# CONCURRENCY is lower than the old IPRoyal setting: each request now costs money rather than
# bandwidth, so there is no reason to race, and Web Unlocker takes ~2-4s per call anyway.
nohup bash -c '
  while true; do
    env CONCURRENCY=4 BATCH=30 STALE_MIN=1440 PG_POOL_MAX=4 ATS=workable \
      BRIGHTDATA_PROXY=1 PROXY_DISABLED=1 SKIP_SLUG_LIKE="wjb\_%" \
      node scripts/crawl-companies-local.js &
    echo $! > /tmp/crawl-E.pid
    wait
    echo "[$(date)] E exited rc=$? — restarting in 15s"; sleep 15
  done
' >/tmp/crawl-E.log 2>&1 &
echo "workable Web Unlocker drain started (wrapper pid $!, node pid -> /tmp/crawl-E.pid)"
echo "log: /tmp/crawl-E.log   stop: kill \$(cat /tmp/crawl-E.pid) && pkill -f 'ATS=workable'"
