/**
 * Parse the board's "date posted" window into a number of seconds.
 *
 * Shared by BOTH read paths on purpose. The SQL path (jobs.js) and the index path
 * (jobs-search.js) each had their own copy of `/^(\d+)\s*([hdwm])$/i`, which accepts "7d" but
 * not "7days". They agreed, so nobody noticed they were both wrong — and they failed
 * differently, which is what made it hard to see:
 *
 *   - SQL: no match meant the date clause was simply never added. The filter silently did
 *     nothing, the user got unfiltered results, and the query became the expensive unfiltered
 *     one — the `canceling statement due to statement timeout` on /api/jobs after the cutover.
 *   - Index: no match returned null, so the request fell back to Postgres and hit exactly that.
 *
 * Accepting only the terse form was a guess about what the frontend sends. It sends the long
 * form too, so accept both, in one place, so the two paths cannot drift again.
 *
 * Returns { seconds, n, unit } or null if the value is genuinely unparseable.
 */
const UNITS = {
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400,
  w: 604800, wk: 604800, wks: 604800, week: 604800, weeks: 604800,
  m: 2592000, mo: 2592000, mon: 2592000, month: 2592000, months: 2592000,
};

// Postgres INTERVAL unit for each bucket, so the SQL path can build its clause from the same
// parse rather than re-deriving it.
const PG_UNIT = { 3600: 'hours', 86400: 'days', 604800: 'weeks', 2592000: 'months' };

function parsePostedWindow(value) {
  const m = String(value == null ? '' : value).trim().toLowerCase().match(/^(\d+)\s*([a-z]+)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const secs = UNITS[m[2]];
  if (!n || n <= 0 || !secs) return null;
  return { seconds: n * secs, n, unit: PG_UNIT[secs] };
}

module.exports = { parsePostedWindow };
