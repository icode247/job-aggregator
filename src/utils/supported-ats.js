/**
 * Single source of truth for the ATS platforms we can actually crawl AND apply to.
 *
 * Import paths (demand-crawl, fetch-resumly*, fetch-wonsulting, import-resumly-file) ingest
 * whatever ATS a third-party source returns. Without this gate they re-fill the DB with jobs on
 * platforms we have no adapter for — jobs users can't apply to and the automation backend rejects.
 * This mirrors the adapter registry in src/adapters/index.js, plus:
 *   - oraclecloud            : Oracle Fusion (variant of oracle; kept per product decision)
 *   - alias variants         : the same underlying ATS under a different label, all applyable via
 *                              the parent adapter (grnhse→greenhouse, myworkdayjobs→workday, …).
 *
 * Keep this list in sync with src/adapters/index.js when adapters are added/removed.
 */
const SUPPORTED_ATS = new Set([
  // 20 adapters (src/adapters/index.js)
  'greenhouse', 'ashby', 'lever', 'workable', 'recruitee', 'smartrecruiters', 'rippling',
  'personio', 'breezy', 'jazzhr', 'workday', 'zoho', 'icims', 'oracle', 'bamboohr', 'taleo',
  'pinpoint', 'successfactors', 'comeet', 'paylocity',
  // Oracle Fusion (kept)
  'oraclecloud',
  // Alias variants that resolve to a supported adapter (applyable via the parent ATS)
  'grnhse', 'myworkdayjobs', 'icims2', 'zohorecruit', 'jworkable',
  'taleo_careersection', 'taleo_selectminds', 'taleo_rss', 'oraclepeoplesoft',
]);

function isSupportedAts(ats) {
  return SUPPORTED_ATS.has(String(ats || '').toLowerCase().trim());
}

module.exports = { SUPPORTED_ATS, isSupportedAts };
