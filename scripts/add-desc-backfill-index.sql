-- Partial index for the description-backfill candidate query.
--
-- THE PROBLEM. backfillForAts asks, per platform:
--
--   SELECT ... FROM jobs j JOIN companies c ON j.company_id = c.id
--    WHERE j.removed_at IS NULL AND j.description IS NULL AND j.ats = $1 AND j.id > $2
--    ORDER BY j.id LIMIT 60
--
-- Only ~1.5% of live jobs still lack a description (measured 2026-08-07: 854 of 55,791 sampled,
-- so roughly 43,000 of 2.8M). Nothing indexes `description IS NULL`, so the keyset walk visits
-- ~98.5% of the table to find the 1.5% it wants. EXPLAIN ANALYZE on a single platform could not
-- finish inside 60s. The caller loops ~15 platforms every 5 minutes, so a platform in that state
-- burned twelve full scans an hour and filled nothing.
--
-- THE INDEX. Partial on exactly the candidate set, keyed to match the query:
--   - WHERE clause mirrors the predicate, so only candidate rows are stored
--   - (ats, id) serves the `ats = $1 AND id > $2` range and the ORDER BY id in one scan
--
-- It is SMALL — tens of thousands of rows, not millions — and it SHRINKS as descriptions get
-- filled, which is the ideal shape: the index is the work queue. That also makes the in-memory
-- cursor reset on worker restart harmless, since scanning from id 0 only walks candidates.
--
-- COST TO BUILD. CONCURRENTLY does not block reads or writes, but it still scans the table
-- twice, and this table is 30GB with 11 crawlers writing to it. Run it in the quiet window
-- (01:00-05:00 UTC) — NOT while the board is under traffic and autovacuum is active. Building it
-- at a bad moment is the same mistake as any other unstaged load change.
--
-- Must run outside a transaction block. If it fails it leaves an INVALID index behind; drop that
-- before retrying:
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
--   DROP INDEX CONCURRENTLY idx_jobs_desc_backfill;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_desc_backfill
    ON jobs (ats, id)
 WHERE removed_at IS NULL AND description IS NULL;

-- Afterwards, confirm the planner uses it and drop the per-ATS cool-off's reason to exist:
--   EXPLAIN SELECT j.id FROM jobs j JOIN companies c ON j.company_id = c.id
--    WHERE j.removed_at IS NULL AND j.description IS NULL AND j.ats = 'greenhouse' AND j.id > 0
--    ORDER BY j.id LIMIT 60;
-- Expect an Index Scan on idx_jobs_desc_backfill, not a Seq Scan on jobs.
