#!/bin/bash
#
# Append one line of board-health metrics to a log. Designed to run hourly from cron.
#
# EVERY BINARY IS AN ABSOLUTE PATH. cron runs with a near-empty environment — no nvm shims, no
# /opt/homebrew on PATH — so `node` and `render` are simply not found the way they are in an
# interactive shell. A cron job that silently logs nothing is worse than no cron job, which is
# why this also writes a line on failure rather than exiting quietly.
#
# The database URL comes from ~/.fastapply-database-url, the same cached credential the crawler
# fleet reads. Calling `heroku config:get` here would work interactively and then fail under cron,
# where the netrc lookup has no HOME set the way it expects.
#
# Metrics and why each one is here:
#   absent=1/2/3   the absence counter's shape. absent=3 is the bucket that gets retired, so if it
#                  CLIMBS steadily the signal has drifted and SYNC_ABSENCE_REMOVAL should come off.
#                  Flat or falling means jobs reach the threshold and clear.
#   retired_1h     how much the pruners are actually removing.
#   outbox         rows waiting to reach the search index. Swings 0-3k between drains; a number
#                  that only grows means removals are not reaching users.
#   meili p50/p90  search latency.
#   fallbacks      searches that gave up on Meili and hit Postgres. THIS IS THE ONE THAT MATTERS —
#                  it is the mechanism that took the board down on 2026-08-20. Latency alone is
#                  invisible to users; fallbacks are not.
#   conns          Postgres connections against the 40 the role is allowed.
#   rss            this machine's total memory, since the whole fleet runs here.

set -uo pipefail

NODE=/Users/codev/.nvm/versions/node/v20.20.0/bin/node
RENDER=/opt/homebrew/bin/render
PY=/usr/bin/python3
REPO=/Users/codev/job-aggregator
LOG="${HEALTH_LOG:-$HOME/job-board-health.log}"

TS=$(/bin/date -u '+%Y-%m-%d %H:%M')

DB=$(/bin/cat "$HOME/.fastapply-database-url" 2>/dev/null)
if [ -z "$DB" ]; then
  echo "$TS  ERROR no database url" >> "$LOG"
  exit 1
fi

# The db module's pino logger writes its JSON to STDOUT and without a trailing newline, so the
# metrics come back glued to a log blob: `conns=17{"level":30,...}`. Filtering with `grep -v msg`
# therefore dropped the entire line, metrics included — the numbers vanished while the surrounding
# log line still looked fine. Strip the JSON objects out instead of discarding the line.
DBLINE=$(cd "$REPO" && NODE_ENV=production DATABASE_URL="$DB" PG_STATEMENT_TIMEOUT=120000 \
  "$NODE" scripts/health-metrics.js 2>/dev/null | /usr/bin/sed 's/{[^{}]*}//g' | /usr/bin/tr -d '\n')
[ -z "$DBLINE" ] && DBLINE="db_unreachable"

MEILI=$("$RENDER" logs --resources srv-d9q2p0dbedkc73avqon0 --limit 400 -o json --confirm 2>/dev/null \
  | /usr/bin/sed 's/\\u001b\[[0-9;]*m//g' \
  | /usr/bin/grep -oE 'time\.idle=[0-9.]+(ms|s|µs)' | /usr/bin/sed 's/time.idle=//' \
  | /usr/bin/awk '/µs$/{sub("µs","");print $0/1000;next} /s$/&&!/ms$/{sub("s","");print $0*1000;next}{sub("ms","");print}' \
  | /usr/bin/sort -n \
  | /usr/bin/awk '{a[NR]=$1} END{if(NR)printf "p50=%.0f p90=%.0f max=%.0f",a[int(NR*.5)],a[int(NR*.9)],a[NR]; else printf "p50=? p90=? max=?"}')

# Bounded to the last hour. An unbounded query returns its own --limit and reports the cap as if
# it were a count, which is how this metric lied once already.
WIN=$(/bin/date -u -r $(( $(/bin/date -u +%s) - 3600 )) '+%Y-%m-%dT%H:%M:%SZ')
FB=$("$RENDER" logs --resources srv-d9q9serm8hqs73e9uio0 --start "$WIN" --text "falling back" \
  --limit 400 -o json --confirm 2>/dev/null | /usr/bin/grep -c '"timestamp"')
[ "${FB:-0}" -ge 400 ] && FB=">=400"

CRAWLERS=$(/bin/ps -Ao pid=,ppid=,command= | /usr/bin/grep 'crawl-companies-local.js' | /usr/bin/grep -v grep | /usr/bin/awk '$2!=1' | /usr/bin/wc -l | /usr/bin/tr -d ' ')
PRUNERS=$(/bin/ps -Ao pid=,ppid=,command= | /usr/bin/grep 'prune-dead-jobs-local' | /usr/bin/grep -v grep | /usr/bin/awk '$2!=1' | /usr/bin/wc -l | /usr/bin/tr -d ' ')
RSS=$(/bin/ps -Ao rss= | /usr/bin/awk '{s+=$1} END{printf "%.1fGB", s/1048576}')

echo "$TS  $DBLINE  meili[$MEILI] fallbacks_1h=$FB  crawlers=$CRAWLERS pruners=$PRUNERS rss=$RSS" >> "$LOG"
