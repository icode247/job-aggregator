#!/usr/bin/env bash
# Seed the search index during the low-traffic window only.
#
# The seed marks ~2.8M live jobs dirty so the normal sync loop ships them. That is a bulk
# UPDATE, and bulk UPDATEs against this database evict the API's working set (1GB
# shared_buffers vs a 40GB table): tried during the day on 2026-08-05/06 it pushed the API to
# ~30% 5xx three times, and each pause restored it immediately.
#
# Traffic from search_demand over 7 days (UTC): quiet 01-05h = 39-126 searches/hr,
# peak 13h/17h = 363/527. So work only inside the window and stop cleanly at the boundary.
#
# Safe to interrupt: meili-init --seed skips rows already marked, so re-running resumes rather
# than restarting, and a partially seeded index is not wrong — /api/jobs and /api/facets are
# still served from Postgres until SEARCH_ENGINE is switched over.
#
#   bash scripts/seed-index-overnight.sh
#
# Env: START_H(1) END_H(5) SEED_BATCH(25000) SEED_PAUSE_MS(1000)
set -u
cd "$(dirname "$0")/.."

START_H="${START_H:-1}"
END_H="${END_H:-5}"
export SEED_BATCH="${SEED_BATCH:-25000}"
export SEED_PAUSE_MS="${SEED_PAUSE_MS:-1000}"
export NODE_ENV=production
export PG_POOL_MAX="${PG_POOL_MAX:-1}"
# connection.js enforces a client-side query_timeout too, so a long batch dies without this.
export PG_STATEMENT_TIMEOUT="${PG_STATEMENT_TIMEOUT:-300000}"

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }

in_window() {
  local h; h=$(date -u +%H); h=${h#0}; h=${h:-0}
  [ "$h" -ge "$START_H" ] && [ "$h" -lt "$END_H" ]
}

while :; do
  if ! in_window; then
    log "outside ${START_H}-${END_H}h UTC — sleeping 15m"
    sleep 900
    continue
  fi

  log "seeding index"
  if node scripts/meili-init.js --seed; then
    log "SEED COMPLETE"
    break
  fi
  log "seed exited non-zero (network blip or window close) — retrying in 60s"
  sleep 60
done
