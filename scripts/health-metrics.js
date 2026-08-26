#!/usr/bin/env node
/**
 * Print one line of database health metrics, for scripts/log-health.sh to append to its log.
 *
 * A separate FILE rather than `node -e '...'` inside the shell script. The inline version needed
 * SQL interval literals ('1 hour') nested inside a single-quoted shell string inside a heredoc,
 * which mangled the quoting and made every cron run report db_unreachable — the metric failed
 * silently while the surrounding line still looked healthy.
 *
 * Always exits 0 and always prints something. A monitoring script that dies on a bad night
 * removes the very data you need to understand the bad night.
 */
const { query, closeDb } = require('../src/db/connection');

(async () => {
  const rows = async (sql) => (await query(sql)).rows;

  // Served by idx_jobs_absent_syncs, which is partial on absent_syncs > 0 — small, and it shrinks
  // as jobs come back. Cheap enough to run hourly against a 28GB table.
  const a = await rows(`SELECT absent_syncs, count(*) AS n
                          FROM jobs
                         WHERE removed_at IS NULL AND absent_syncs > 0
                         GROUP BY 1 ORDER BY 1 LIMIT 4`);
  const m = Object.fromEntries(a.map((r) => [String(r.absent_syncs), Number(r.n)]));

  const retired = (await rows(
    `SELECT count(*) AS n FROM jobs WHERE removed_at > NOW() - INTERVAL '1 hour'`))[0].n;
  const outbox = (await rows(
    `SELECT count(*) AS n FROM jobs WHERE index_dirty_at IS NOT NULL`))[0].n;
  const conns = (await rows('SELECT count(*) AS n FROM pg_stat_activity'))[0].n;

  process.stdout.write(
    `absent1=${m['1'] || 0} absent2=${m['2'] || 0} absent3=${m['3'] || 0} `
    + `retired_1h=${retired} outbox=${outbox} conns=${conns}`
  );
  await closeDb();
  process.exit(0);
})().catch((err) => {
  process.stdout.write(`db_error=${String(err.message).slice(0, 50).replace(/\s+/g, '_')}`);
  process.exit(0);
});
