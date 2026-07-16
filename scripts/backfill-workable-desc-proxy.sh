#!/usr/bin/env bash
# Backfill missing Workable job DESCRIPTIONS through the IPRoyal rotating proxy.
# The v3 sync only stores metadata (description=null); this fetches each job's v2
# detail (apply.workable.com/api/v2/.../jobs/{shortcode}, ~5.5KB JSON each) which
# is 403/429-blocked without the proxy. Concurrency 6, fresh IP per request.
# Bandwidth: ~5.5KB/job (~0.14GB for ~25k jobs). Watch IPRoyal remaining traffic.
# Stop: kill $(cat /tmp/backfill-wk-desc.pid)
set -u
cd "$(dirname "$0")/.."
export DATABASE_URL="$(heroku config:get DATABASE_URL -a fastapply-board 2>/dev/null)"
export NODE_ENV=production
[ -z "$DATABASE_URL" ] && { echo "FATAL: no DATABASE_URL"; exit 1; }

if [ -f /tmp/backfill-wk-desc.pid ] && kill -0 "$(cat /tmp/backfill-wk-desc.pid)" 2>/dev/null; then
  echo "backfill already running (pid $(cat /tmp/backfill-wk-desc.pid))"; exit 0
fi

nohup bash -c '
  while true; do
    env WK_DESC_DELAY_MS=0 WK_DESC_BATCH=200 WK_DESC_CONCURRENCY=6 WK_DESC_MAX_FAIL=9999 \
      node src/tasks/backfill-workable-descriptions.js &
    echo $! > /tmp/backfill-wk-desc.pid
    wait
    rc=$?
    # Runner exits 0 when the queue is drained; only restart on a crash.
    [ "$rc" = "0" ] && { echo "[$(date)] backfill finished cleanly"; break; }
    echo "[$(date)] backfill crashed rc=$rc — restarting in 15s"; sleep 15
  done
' >/tmp/backfill-wk-desc.log 2>&1 &
echo "workable description backfill started (wrapper pid $!, node pid -> /tmp/backfill-wk-desc.pid)"
echo "log: /tmp/backfill-wk-desc.log"
