/**
 * Country-name aliases for job-location search.
 *
 * Locations are stored as free text ("Abu Dhabi, Abu Dhabi, United Arab Emirates"), so a naive
 * `location ILIKE '%UAE%'` misses the ~7k jobs stored as "United Arab Emirates" (only ~600 say
 * "UAE"). This maps each country to its common variants so searching any one matches all forms.
 *
 * SAFETY: short/ambiguous aliases (us, uk, usa, uae — length <= 4) must be matched as WHOLE
 * WORDS, never substrings, or "us" would match Houston/Austin and "uk" would match Milwaukee.
 * The consumer (jobs repo) uses a word-boundary regex for those and a substring match for the
 * long, unambiguous forms.
 */
const GROUPS = [
  ['united states', 'united states of america', 'usa', 'us', 'america'],
  ['united kingdom', 'great britain', 'britain', 'uk'],
  ['united arab emirates', 'emirates', 'uae'],
  ['netherlands', 'holland'],
  ['germany', 'deutschland'],
];

const MAP = new Map();
for (const g of GROUPS) for (const a of g) MAP.set(a, g);

// Return the full alias group for a location term (lowercased list), or null if it has none.
function aliasGroup(term) {
  const t = String(term || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return MAP.get(t) || null;
}

// True for aliases that must be matched as whole words (short/ambiguous), not substrings.
function isShortAlias(alias) {
  return String(alias).length <= 4;
}

module.exports = { aliasGroup, isShortAlias };
