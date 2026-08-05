#!/usr/bin/env node
/**
 * Run a large UPDATE against the live jobs table without taking the site down.
 *
 * A single 600k-row UPDATE was tried on 2026-08-05 and had to be cancelled after 27 minutes:
 * it sat in IO/DataFileRead the whole time, competed with user queries for the same disk, and
 * pushed the API to ~30% 5xx. Cancelling it restored the site immediately. The work itself was
 * fine — doing it in one transaction was not.
 *
 * So: keyset batches, each its own transaction, with a pause between them, and an adaptive
 * check that backs off whenever the database is already busy serving somebody. Resumable via a
 * checkpoint file, because a 4.5M-row table will not finish in one sitting.
 *
 *   PRESET=workplace_type node scripts/backfill-batched.js
 *   PRESET=role_category  node scripts/backfill-batched.js
 *
 * Env: BATCH (25000) PAUSE_MS (1500) MAX_BUSY_WAIT_S (120) CHECKPOINT (/tmp/backfill-<preset>.pos)
 */
const fs = require('fs');
const { query, closeDb } = require('../src/db/connection');
const logger = require('../src/logger');

const BATCH = parseInt(process.env.BATCH || '25000', 10);
const PAUSE_MS = parseInt(process.env.PAUSE_MS || '1500', 10);
const MAX_BUSY_WAIT_S = parseInt(process.env.MAX_BUSY_WAIT_S || '120', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each preset mirrors a normaliser in src/utils/extract.js. Kept as SQL so the whole batch is
// one server-side statement rather than millions of round-trips.
const PRESETS = {
  workplace_type: {
    set: `workplace_type = CASE
            WHEN lower(replace(replace(workplace_type,'_',' '),'-',' ')) ~ 'hybrid' THEN 'Hybrid'
            WHEN lower(replace(replace(workplace_type,'_',' '),'-',' ')) ~ 'remote|work from home|wfh' THEN 'Remote'
            WHEN lower(replace(replace(workplace_type,'_',' '),'-',' ')) ~ 'on ?site|in office|in person|office' THEN 'Onsite'
            ELSE NULL END`,
    where: `workplace_type IS NOT NULL AND workplace_type NOT IN ('Remote','Hybrid','Onsite')`,
  },
  // Mirrors classifyRoleCategory() in src/utils/classify.js — same rules, same order.
  role_category: {
    set: `role_category = CASE
            WHEN lower(title) ~ 'software engineer|software developer' THEN 'Software Engineer'
            WHEN lower(title) ~ 'frontend|front-end|front end' THEN 'Frontend Developer'
            WHEN lower(title) ~ 'backend|back-end|back end' THEN 'Backend Developer'
            WHEN lower(title) ~ 'full stack|fullstack' THEN 'Fullstack Developer'
            WHEN lower(title) ~ 'data scientist' THEN 'Data Scientist'
            WHEN lower(title) ~ 'data analyst' THEN 'Data Analyst'
            WHEN lower(title) ~ 'data engineer' THEN 'Data Engineer'
            WHEN lower(title) ~ 'machine learning|ml engineer|ai engineer' THEN 'ML / AI Engineer'
            WHEN lower(title) ~ 'product manager' THEN 'Product Manager'
            WHEN lower(title) ~ 'project manager' THEN 'Project Manager'
            WHEN lower(title) ~ 'product designer|ux designer|ui designer' THEN 'Product Designer'
            WHEN lower(title) ~ 'devops|site reliability|sre' THEN 'DevOps / SRE'
            WHEN lower(title) ~ 'qa|quality assurance|test engineer' THEN 'QA Engineer'
            WHEN lower(title) ~ 'mobile|ios|android' THEN 'Mobile Developer'
            WHEN lower(title) ~ 'marketing' THEN 'Marketing'
            WHEN lower(title) ~ 'sales|account executive|business development' THEN 'Sales'
            WHEN lower(title) ~ 'customer success|customer support' THEN 'Customer Support'
            WHEN lower(title) ~ 'security|cybersecurity' THEN 'Security Engineer'
            WHEN lower(title) ~ 'cloud|infrastructure' THEN 'Cloud / Infrastructure'
            WHEN lower(title) ~ 'technical writer|content writer' THEN 'Technical Writer'
            WHEN lower(title) ~ 'recruiter|talent' THEN 'Recruiter'
            WHEN lower(title) ~ 'finance|accountant|financial' THEN 'Finance'
            WHEN lower(title) ~ 'human resources|hr ' THEN 'Human Resources'
            ELSE 'Other' END`,
    where: `role_category IS NULL`,
  },
};

async function dbIsBusy() {
  // Anything the API is running for more than 3s means we are already contending for IO.
  const { rows } = await query(
    `SELECT COUNT(*) n FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'active'
        AND query NOT ILIKE 'UPDATE jobs%' AND query NOT ILIKE '%pg_stat_activity%'
        AND query_start < NOW() - INTERVAL '3 seconds'`
  );
  return parseInt(rows[0].n, 10) > 0;
}

(async () => {
  const name = process.env.PRESET;
  const preset = PRESETS[name];
  if (!preset) {
    console.error(`unknown PRESET '${name}'. known: ${Object.keys(PRESETS).join(', ')}`);
    process.exit(1);
  }
  const checkpoint = process.env.CHECKPOINT || `/tmp/backfill-${name}.pos`;

  // NOTE: statement_timeout alone is not enough — src/db/connection.js also sets a
  // client-side query_timeout and the pg driver aborts on that regardless of what the server
  // allows. Run this with PG_STATEMENT_TIMEOUT set; it drives both.
  await query('SET statement_timeout = 0');
  let from = fs.existsSync(checkpoint) ? parseInt(fs.readFileSync(checkpoint, 'utf8'), 10) || 0 : 0;
  console.log(`preset=${name} batch=${BATCH} pause=${PAUSE_MS}ms resuming from id>${from}`);

  let updated = 0, batches = 0, backoffs = 0;
  const t0 = Date.now();

  // Iterate over MATCHING rows, not id ranges. Job ids are sparse — they run past 245M for
  // ~4.5M rows — so stepping the id space in fixed windows would spend thousands of batches
  // scanning empty gaps. Selecting the next N matching ids keeps every batch full and lets the
  // loop stop as soon as nothing is left to fix.
  for (;;) {
    // Back off while the API is busy. Bounded, so a permanently busy database still makes
    // progress rather than stalling forever.
    let waited = 0;
    while (await dbIsBusy() && waited < MAX_BUSY_WAIT_S) {
      backoffs++; await sleep(5000); waited += 5;
    }

    const res = await query(
      `WITH batch AS (
         SELECT id FROM jobs
          WHERE id > ${from} AND ${preset.where}
          ORDER BY id LIMIT ${BATCH}
       )
       UPDATE jobs SET ${preset.set}
        WHERE id IN (SELECT id FROM batch)
       RETURNING id`
    );
    if (!res.rowCount) break;

    from = res.rows.reduce((m, r) => Math.max(m, Number(r.id)), from);
    updated += res.rowCount;
    batches++;
    fs.writeFileSync(checkpoint, String(from));

    if (batches % 5 === 0) {
      const mins = ((Date.now() - t0) / 60000).toFixed(1);
      console.log(`  updated=${updated}  batches=${batches}  backoffs=${backoffs}  lastId=${from}  ${mins}m`);
    }
    await sleep(PAUSE_MS);
  }

  console.log(`done: ${updated} rows updated in ${batches} batches, ${backoffs} backoffs, ${((Date.now() - t0) / 60000).toFixed(1)}m`);
  fs.existsSync(checkpoint) && fs.unlinkSync(checkpoint);
  await closeDb();
})().catch((err) => { logger.error({ err: err.message }, 'backfill failed'); process.exit(1); });
