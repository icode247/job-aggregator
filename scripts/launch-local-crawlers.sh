#!/usr/bin/env bash
# Relaunch the local companion crawlers that support the Heroku board.
# Survives this shell (nohup + detached). Each company crawler auto-restarts on
# crash via a `while true` wrapper; a full machine reboot needs this script re-run.
#
# Partitioning is DISJOINT by ATS so no two instances hammer the same ATS
# (double-hitting triggers rate limits). Throttled: CONCURRENCY=3, DELAY_MS=400.
set -u
cd "$(dirname "$0")/.."

# Don't double-launch: if crawlers are already running (e.g. this fires at login
# but they're still up from before), bail out. FORCE=1 overrides.
if [ "${FORCE:-0}" != "1" ] && pgrep -f "crawl-companies-local|crawl-workable-marketplace" >/dev/null 2>&1; then
  echo "[$(date)] crawlers already running — skipping launch (set FORCE=1 to override)"
  exit 0
fi

export DATABASE_URL="$(heroku config:get DATABASE_URL -a fastapply-board 2>/dev/null)"
export NODE_ENV=production
[ -z "$DATABASE_URL" ] && { echo "FATAL: no DATABASE_URL"; exit 1; }

LOG=/tmp
# essential-2 Postgres caps at 40 connections; keep per-crawler pools small so the
# ~7 instances + backfill + Heroku dynos stay well under the cap.
COMMON="CONCURRENCY=3 DELAY_MS=400 PG_POOL_MAX=2"

launch() { # name  ATS-list  logfile  [env-override]
  local name="$1" ats="$2" log="$3" envs="${4:-$COMMON}"
  nohup bash -c "while true; do \
    env $envs ATS='$ats' node scripts/crawl-companies-local.js; \
    echo \"[$(date)] $name exited rc=\$? — restarting in 5s\"; sleep 5; \
  done" >"$log" 2>&1 &
  echo "launched $name (ATS: $ats) -> $log  wrapper pid $!"
}

# Instance A (bamboohr,lever): both ATS work fine crawled DIRECT, so force
# PROXY_DISABLED=1 — the IPRoyal residential proxy is metered/often-down, and
# routing bamboohr/lever through it just fails (100% errors when the proxy lapses).
launch A "bamboohr,lever"                          "$LOG/crawl-A.log" "$COMMON PROXY_DISABLED=1"
# B/C/F crawl DIRECT (PROXY_DISABLED=1). These ATS all expose public JSON APIs that
# don't IP-block, so the laptop's own residential IP is enough — the proxy added nothing
# but a socket leak. On the metered IPRoyal proxy they ran 100% errors (EADDRNOTAVAIL,
# ephemeral-port exhaustion) for ~71h and stored 0 jobs; direct they flow at hundreds/min.
launch B "smartrecruiters,recruitee,zoho,breezy"   "$LOG/crawl-B.log" "$COMMON PROXY_DISABLED=1"
launch C "ashby,greenhouse"                         "$LOG/crawl-C.log" "$COMMON PROXY_DISABLED=1"
launch F "rippling"                                "$LOG/crawl-F.log" "$COMMON PROXY_DISABLED=1"
# Instance J (jazzhr): applytojob.com JSON API, works DIRECT. Added when the ats-slugs
# seed brought in ~2.5k jazzhr companies that nothing was crawling.
launch J "jazzhr"                                  "$LOG/crawl-J.log" "$COMMON PROXY_DISABLED=1"
# Instance TT (teamtailor): public {slug}.teamtailor.com/jobs.json feed, direct. Feed carries full
# descriptions (no backfill needed). Seeded ~1.5k companies from the ats-slugs dump. Caps 100/company.
launch TT "teamtailor"                             "$LOG/crawl-TT.log" "$COMMON PROXY_DISABLED=1"
# Instance P (pinpoint): distinct host (pinpointhq.com), plain JSON API — but it
# FAILS through the residential proxy, so force PROXY_DISABLED=1 (crawls direct).
launch P "pinpoint"                                "$LOG/crawl-P.log" "$COMMON PROXY_DISABLED=1"
# Instance Cm (comeet): comeet.co careers-api, slug = "{UID}:{TOKEN}" (discovered
# via scripts/discover-comeet.js). Also crawls direct — PROXY_DISABLED=1.
launch Cm "comeet"                                 "$LOG/crawl-Cm.log" "$COMMON PROXY_DISABLED=1"
# Instance Pay (paylocity): recruiting.paylocity.com careers pages, slug = tenant GUID.
# Jobs live in a `window.pageData` blob (feed API is dead) — see src/adapters/paylocity.js.
# Works direct (no proxy); the adapter self-throttles with jitter+backoff.
launch Pay "paylocity"                              "$LOG/crawl-Pay.log" "$COMMON PROXY_DISABLED=1"
# Instance E (workable direct via IPRoyal proxy) is intentionally NOT auto-started
# here: it uses the METERED residential proxy, so it must be a controlled one-time
# drain, not an always-on refresh loop (a 60-min refresh would burn the GB plan).
# Run it manually with: bash scripts/drain-workable-proxy.sh

# Marketplace deep crawl: one-shot walk of the full ~170k; auto-restart resumes
# from the top if it dies (upserts dedupe, so re-walking is harmless).
nohup bash -c "while true; do \
  env MARKETPLACE_MAX_PAGES=8500 PG_POOL_MAX=4 node src/tasks/crawl-workable-marketplace.js; \
  echo \"[\$(date)] MKT exited rc=\$? — restarting in 30s\"; sleep 30; \
done" >"$LOG/crawl-MKT.log" 2>&1 &
echo "launched MKT (workable marketplace deep) -> $LOG/crawl-MKT.log  wrapper pid $!"

# Comeet description backfill: comeet's API has no descriptions — they live in each
# job's SEO page (og:description), fetched via Bright Data. LOOP re-checks for newly
# crawled jobs; auto-restart wrapper survives OS reaping of the idle sleep.
nohup bash -c "while true; do \
  env LOOP=1 CONCURRENCY=6 BATCH=200 RECHECK_S=900 PG_POOL_MAX=2 node scripts/backfill-comeet-desc.js; \
  echo \"[\$(date)] comeet-desc exited rc=\$? — restarting in 30s\"; sleep 30; \
done" >"$LOG/backfill-comeet.log" 2>&1 &
echo "launched comeet description backfill -> $LOG/backfill-comeet.log  wrapper pid $!"

# Paylocity description backfill: paylocity's list crawl carries no description; the full
# text is on each Jobs/Details/{id} page as a JSON-LD JobPosting (backfill-descriptions.js
# fetchPaylocityDescription). Direct fetch, no proxy; self-throttles (UA-rotation + jitter).
# LOOP re-checks for newly crawled jobs; batch/concurrency come from ATS_CONFIG (60/3).
nohup bash -c "while true; do \
  env LOOP=1 RECHECK_S=900 PG_POOL_MAX=2 node scripts/backfill-desc-generic.js paylocity; \
  echo \"[\$(date)] paylocity-desc exited rc=\$? — restarting in 30s\"; sleep 30; \
done" >"$LOG/backfill-paylocity.log" 2>&1 &
echo "launched paylocity description backfill -> $LOG/backfill-paylocity.log  wrapper pid $!"


echo "all crawlers launched."
