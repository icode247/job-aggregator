#!/usr/bin/env node
/**
 * Import confirmed Jobvite boards discovered by scripts/discover-jobvite.js.
 *
 * Reads the discovery JSONL and creates one company per board that has live openings.
 *
 * THE COMPANY NAME COMES FROM JOBVITE, NEVER FROM THE MATCHED CANDIDATE.
 *
 * Discovery generates slug guesses from the companies we already track, so every hit carries a
 * `matchedCompany` — the company whose name/domain produced the guess. That match is a candidate
 * generator, NOT evidence of identity, and on short generic slugs it is routinely wrong:
 *
 *   slug=parkland   jobvite="Parkland Corporation"          matched="Parkland Animal Clinic"
 *   slug=caa        jobvite="NFL"                           matched="caa"
 *   slug=ccu        jobvite="Colorado Christian University"  matched="CCU, LLC"
 *   slug=paint      jobvite="Yaymaker"                      matched="Paint ltd"
 *
 * 11 of the 40 boards with jobs disagreed this way. Attaching to the matched company would have
 * filed 93 fuel-and-convenience jobs under a veterinary clinic. Jobvite's own hiringOrganization
 * (read from each posting's JobPosting JSON-LD) is the authority on whose board it is, so a board
 * with no name from Jobvite is SKIPPED rather than guessed.
 *
 * Dedup is on career_url, the table's only unique key besides id. That is also what keeps a
 * company already tracked on another ATS from colliding: a Jobvite board is a different
 * career_url, so it becomes its own row rather than overwriting the existing one.
 *
 * domain is NOT NULL in this schema and there is no real company domain in the discovery data,
 * so it is set to jobs.jobvite.com. That is safe for the logo pipeline specifically because
 * `jobvite` is already in its ATS_HOST vendor-art pattern (scripts/logo-review/icon-scrape.js),
 * so these rows are skipped rather than all being assigned Jobvite's own logo.
 *
 * AGENCY BOARDS ARE EXCLUDED BY SLUG, not detected automatically.
 *
 * The hiringOrganization rule above assumes one board belongs to one company. That breaks for
 * staffing and benefits firms who run recruiting on behalf of clients: jobs.jobvite.com/onedigital
 * is titled "OneDigital Northeast Careers" but its postings carry hiringOrganization "Saint Vincent
 * de Paul" — a client, not the board owner. Taking the first posting's name would file the board
 * under whichever client happened to post most recently, and it would change on the next crawl.
 * There is no reliable signal for this in a single posting, so known agency boards are listed in
 * EXCLUDE and skipped until someone decides how to model a multi-tenant board.
 *
 *   IN         discovery JSONL      (default data/jobvite-slugs.jsonl)
 *   APPLY=1    actually write       (default 0 = dry run)
 *   MIN_JOBS   only import boards with at least this many openings (default 1)
 *   EXCLUDE    comma-separated slugs to skip (default: known agency boards)
 */
const fs = require('fs');
const path = require('path');
const { query, closeDb } = require('../src/db/connection');

const IN = process.env.IN || path.join(__dirname, '..', 'data', 'jobvite-slugs.jsonl');
const APPLY = process.env.APPLY === '1';
const MIN_JOBS = parseInt(process.env.MIN_JOBS || '1', 10);
// Multi-tenant agency boards — see the header. Override with EXCLUDE= to import anyway.
const DEFAULT_EXCLUDE = 'onedigital';
const EXCLUDE = new Set(
  (process.env.EXCLUDE ?? DEFAULT_EXCLUDE).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);

function clean(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function main() {
  const rows = fs.readFileSync(IN, 'utf8').split('\n')
    .filter((l) => l.trim()).map((l) => JSON.parse(l));

  const withJobs = rows.filter((r) => (r.jobs || 0) >= MIN_JOBS);
  const excluded = withJobs.filter((r) => EXCLUDE.has(String(r.slug).toLowerCase()));
  const eligible = withJobs.filter((r) => !EXCLUDE.has(String(r.slug).toLowerCase()));
  const named = eligible.filter((r) => clean(r.jobviteName));
  const unnamed = eligible.filter((r) => !clean(r.jobviteName));

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${rows.length} boards in file`);
  console.log(`  with >= ${MIN_JOBS} jobs : ${withJobs.length}`);
  if (excluded.length) {
    console.log(`  skipped (agency board)  : ${excluded.length} -> ${excluded.map((r) => r.slug).join(', ')}`);
  }
  console.log(`  importable (named)      : ${named.length}`);
  console.log(`  skipped (no jobvite name): ${unnamed.length}${unnamed.length ? ' -> ' + unnamed.map((r) => r.slug).join(', ') : ''}`);
  console.log();

  let inserted = 0, updated = 0, failed = 0;
  for (const r of named) {
    const careerUrl = `https://jobs.jobvite.com/${r.slug}`;
    const name = clean(r.jobviteName);
    const renamed = clean(r.matchedCompany) && clean(r.matchedCompany).toLowerCase() !== name.toLowerCase();

    if (!APPLY) {
      console.log(`  would import  ${String(r.jobs).padStart(4)} jobs  ${r.slug.padEnd(22)} "${name}"` +
        (renamed ? `   (candidate was "${clean(r.matchedCompany)}" — using Jobvite's name)` : ''));
      continue;
    }
    try {
      const res = await query(
        `INSERT INTO companies (company_name, ats, ats_slug, career_url, domain, status, origin,
                                last_synced_at, created_at, updated_at)
         VALUES ($1,'jobvite',$2,$3,'jobs.jobvite.com','active','jobvite_discovery',NULL,NOW(),NOW())
         ON CONFLICT (career_url) DO UPDATE
           SET ats = 'jobvite', ats_slug = EXCLUDED.ats_slug, status = 'active', updated_at = NOW()
         RETURNING (xmax = 0) AS is_insert`,
        [name, r.slug, careerUrl]
      );
      res.rows[0]?.is_insert ? inserted++ : updated++;
    } catch (err) {
      failed++;
      console.error(`  FAIL ${r.slug}: ${err.message}`);
    }
  }

  if (APPLY) {
    console.log(`\ninserted ${inserted}  updated ${updated}  failed ${failed}`);
    console.log('last_synced_at is NULL, so the jobvite crawler will claim these on its next pass.');
  } else {
    console.log('\ndry run — rerun with APPLY=1 to write');
  }
  await closeDb();
  process.exit(0);
}

main().catch((err) => { console.error('fatal:', err.message); process.exit(1); });
