#!/usr/bin/env bash
# One-time drain of apply.workable.com (direct per-company API) through the IPRoyal
# rotating-residential proxy. Workable 403-blocks datacenter IPs (Heroku) and
# 429/404-blocks a single residential IP after ~1-2 requests, so proxy.js rotates
# a fresh residential IP PER REQUEST (see src/utils/proxy.js).
#
# STALE_MIN=1440 (24h): every reactivated workable company is due now, so it drains
# the whole backlog once, retries the ~30% that error on a slow IP, then IDLES
# (nothing due for 24h) instead of re-burning the metered proxy plan.
#
# Bandwidth: ~2 compact JSON requests/company, ~0.4-0.5 GB for a full ~9.7k pass.
# WATCH your IPRoyal remaining traffic. Stop anytime: kill $(cat /tmp/crawl-E.pid)
set -u
cd "$(dirname "$0")/.."
export DATABASE_URL="$(heroku config:get DATABASE_URL -a fastapply-board 2>/dev/null)"
export NODE_ENV=production
[ -z "$DATABASE_URL" ] && { echo "FATAL: no DATABASE_URL"; exit 1; }

if [ -f /tmp/crawl-E.pid ] && kill -0 "$(cat /tmp/crawl-E.pid)" 2>/dev/null; then
  echo "E already running (pid $(cat /tmp/crawl-E.pid)). Stop it first: kill \$(cat /tmp/crawl-E.pid)"; exit 0
fi

nohup bash -c '
  while true; do
    env CONCURRENCY=6 BATCH=30 STALE_MIN=1440 PG_POOL_MAX=4 ATS=workable \
      node scripts/crawl-companies-local.js &
    echo $! > /tmp/crawl-E.pid
    wait
    echo "[$(date)] E exited rc=$? — restarting in 15s"; sleep 15
  done
' >/tmp/crawl-E.log 2>&1 &
echo "workable proxy drain started (wrapper pid $!, node pid -> /tmp/crawl-E.pid)"
echo "log: /tmp/crawl-E.log   stop: kill \$(cat /tmp/crawl-E.pid) && pkill -f 'ATS=workable'"
