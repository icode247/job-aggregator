-- Drop redundant indexes on `jobs`.
--
-- WHY: every INSERT and UPDATE maintains all 26 indexes on this table. That write amplification
-- is what produces dead tuples, which triggers autovacuum, which saturates I/O and times out the
-- maintenance loops. Fewer indexes means cheaper writes and less vacuum work.
--
-- SIZES, measured 2026-08-06: heap 5.3GB, indexes 2.5GB, TOAST 23.0GB. The indexes are NOT the
-- bulk of this table — descriptions are. This is a write-cost change, not a disk-space one.
--
-- Every drop below is justified STRUCTURALLY (one index is a prefix of another), not by scan
-- counts. The stats on this database were reset when it was created on 2026-08-05, so they cover
-- roughly a day and a half — long enough to see hot paths, nowhere near long enough to prove an
-- index is unused.
--
-- CONCURRENTLY so no drop takes an exclusive lock on a table the live board is reading. Each
-- statement must run on its own, outside a transaction block — do not wrap this file in BEGIN.
-- Run them one at a time and check the board between.

-- ---------------------------------------------------------------------------------------------
-- TIER 1 — strictly redundant. A composite index whose LEADING column matches serves every query
-- the single-column index serves, so these are pure duplication.
-- ---------------------------------------------------------------------------------------------

-- btree (external_id) — covered by jobs_external_id_company_id_key :: btree (external_id, company_id).
-- 248 MB. The composite already takes 678k scans; this one takes 601 because the planner
-- occasionally prefers the narrower index for the identical lookup.
DROP INDEX CONCURRENTLY IF EXISTS idx_jobs_external_id;

-- btree (COALESCE(posted_at, first_seen_at) DESC) WHERE removed_at IS NULL — covered by
-- idx_jobs_active_posted_ats, which is the same expression and the same predicate with `ats`
-- appended. 62 MB.
DROP INDEX CONCURRENTLY IF EXISTS idx_jobs_active_posted_eff;

-- ---------------------------------------------------------------------------------------------
-- TIER 2 — not strictly redundant, but no query shape in this codebase can use them. Weaker
-- evidence than tier 1; drop after tier 1 is confirmed harmless.
-- ---------------------------------------------------------------------------------------------

-- btree (location), unpartitioned. Location is searched with ILIKE '%term%', which a btree cannot
-- serve — that is what idx_jobs_location_trgm (GIN trigram) is for. Exact-match location lookups
-- go through idx_jobs_location_active. 90 MB, 0 scans.
DROP INDEX CONCURRENTLY IF EXISTS idx_jobs_location;

-- btree (removed_at), unpartitioned and low-selectivity: the column is NULL for nearly every live
-- row. Queries filter `removed_at IS NULL`, which the ~15 partial indexes already encode in their
-- WHERE clause. 58 MB, 2 scans.
DROP INDEX CONCURRENTLY IF EXISTS idx_jobs_removed_at;

-- ---------------------------------------------------------------------------------------------
-- DELIBERATELY KEPT
-- ---------------------------------------------------------------------------------------------
-- idx_jobs_last_checked :: btree (last_checked_at) WHERE removed_at IS NULL — 30 MB, 0 scans.
-- Zero scans because the dead-job pruner's candidate query cannot use it (the `id % N` partition
-- and an OR spanning jobs/companies force a sequential scan). It is exactly the index that query
-- needs once it is rewritten to be index-driven, and 30 MB is cheap insurance against rebuilding
-- it on a 2.8M-row table later.
--
-- The full-text and location-search indexes (idx_jobs_search, idx_jobs_search_active,
-- idx_jobs_location_trgm, idx_jobs_location_active, idx_jobs_active_fs_loc,
-- idx_jobs_active_shuffled — roughly 990 MB together) become droppable only AFTER the
-- Meilisearch cutover is live, because until then Postgres is still serving search.
