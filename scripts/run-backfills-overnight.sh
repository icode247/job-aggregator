#!/usr/bin/env bash
# Run the pending backfills inside the low-traffic window only.
#
# Why this exists: these backfills and the live API compete for the same disk. standard-0 has
# ~1GB shared_buffers against a 40GB table, so a backfill evicts the API's working set, the
# API's queries slow past the 15s statement timeout, /api/stats and /api/jobs start returning
# 500s — and the backfill's own back-off logic then yields to those slow queries, so it barely
# progresses either. Tried during the day on 2026-08-05/06 and it degraded the site three
# times; each pause restored it immediately.
#
# Traffic measured from search_demand over 7 days (UTC):
#   quiet  01-05h  = 39-126 searches/hr
#   peak   13h/17h = 363/527 searches/hr
# So: only work between START_H and END_H, and stop cleanly at the boundary.
#
# Both presets are resumable via their checkpoint files, so stopping mid-run costs nothing and
# neither is required for correctness — the deployed filters handle partially-normalised data,
# and new rows are already written correctly by jobsRepo.
#
#   bash scripts/run-backfills-overnight.sh
#
# Env: START_H(1) END_H(5) BATCH(25000) PAUSE_MS(1500)
set -u
cd "$(dirname "$0")/.."

START_H="${START_H:-1}"
END_H="${END_H:-5}"
BATCH="${BATCH:-25000}"
PAUSE_MS="${PAUSE_MS:-1500}"

export DATABASE_URL="${DATABASE_URL:-$(heroku config:get DATABASE_URL -a fastapply-board 2>/dev/null)}"
export NODE_ENV=production
export PG_POOL_MAX=1
# connection.js also sets a client-side query_timeout that the driver enforces regardless of
# the server's statement_timeout — a batch that outlives it dies with "Query read timeout".
export PG_STATEMENT_TIMEOUT=300000
[ -z "$DATABASE_URL" ] && { echo "FATAL: no DATABASE_URL"; exit 1; }

in_window() {
  local h; h=$(date -u +%H); h=${h#0}; h=${h:-0}
  [ "$h" -ge "$START_H" ] && [ "$h" -lt "$END_H" ]
}

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }

# role_category first: it retires the ~40s /api/roles scan, so it is worth real money.
# workplace_type is cosmetic — the work-mode filter already matches both spellings.
for preset in role_category workplace_type; do
  remaining=1
  while [ "$remaining" -gt 0 ]; do
    if ! in_window; then
      log "outside ${START_H}-${END_H}h UTC window — sleeping 15m (preset=$preset)"
      sleep 900
      continue
    fi

    log "running preset=$preset"
    # The script exits non-zero on a network blip from this machine; the checkpoint means the
    # next attempt resumes rather than restarts.
    PRESET="$preset" BATCH="$BATCH" PAUSE_MS="$PAUSE_MS" node scripts/backfill-batched.js
    rc=$?
    if [ $rc -eq 0 ]; then
      log "preset=$preset COMPLETE"
      remaining=0
    else
      log "preset=$preset exited rc=$rc (likely a network blip) — retrying in 60s"
      sleep 60
    fi
  done
done

log "all backfills complete"
