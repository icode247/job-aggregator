#!/usr/bin/env node
/**
 * Local check for the batched syncForCompany upsert.
 *
 *   DATABASE_URL=postgres://localhost/jobsync_test node scripts/test-sync-batch.js   # Postgres
 *   DATABASE_PATH=/tmp/jobsync-test.db        node scripts/test-sync-batch.js        # SQLite
 *
 * Asserts row STATE after each sync, not just that nothing threw — the batching
 * rewrite has to preserve upsert semantics exactly, including the COALESCE on
 * description and the non-empty guards on visa_sponsorship/experience_level.
 */
const assert = require('assert');

async function main() {
  const { migrate, closeDb } = require('../src/db');
  const { query } = require('../src/db/connection');
  const jobsRepo = require('../src/db/repositories/jobs');
  const dialect = process.env.DATABASE_URL ? 'postgres' : 'sqlite';

  await migrate();
  await query('DELETE FROM jobs');
  await query('DELETE FROM companies');
  await query(
    `INSERT INTO companies (career_url, domain, ats, ats_slug, company_name) VALUES (?, ?, ?, ?, ?)`,
    ['https://example.com/careers', 'example.com', 'greenhouse', 'example', 'Example Co']
  );
  const { rows: [company] } = await query('SELECT id FROM companies LIMIT 1');
  const cid = company.id;

  const mk = (i, over = {}) => ({
    external_id: `job-${i}`,
    title: `Engineer ${i}`,
    location: 'Remote',
    url: `https://example.com/jobs/${i}`,
    description: `Description for ${i}`,
    ...over,
  });

  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`  ok   ${name}`); }
    catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
  };

  console.log(`\n=== ${dialect} ===`);

  // 1. Fresh insert spanning several chunks (CHUNK is 200).
  await check('inserts 450 jobs across chunk boundaries', async () => {
    const res = await jobsRepo.syncForCompany(cid, 'greenhouse', Array.from({ length: 450 }, (_, i) => mk(i)));
    assert.strictEqual(res.added, 450, `added=${res.added}`);
    assert.strictEqual(res.updated, 0, `updated=${res.updated}`);
    const { rows } = await query('SELECT COUNT(*) AS c FROM jobs WHERE company_id = ?', [cid]);
    assert.strictEqual(Number(rows[0].c), 450, `row count=${rows[0].c}`);
  });

  // 2. Re-sync updates in place rather than duplicating.
  await check('re-sync updates, does not duplicate', async () => {
    const res = await jobsRepo.syncForCompany(cid, 'greenhouse',
      Array.from({ length: 450 }, (_, i) => mk(i, { title: `Updated ${i}` })));
    assert.strictEqual(res.updated, 450, `updated=${res.updated}`);
    assert.strictEqual(res.added, 0, `added=${res.added}`);
    const { rows } = await query('SELECT COUNT(*) AS c FROM jobs WHERE company_id = ?', [cid]);
    assert.strictEqual(Number(rows[0].c), 450, `row count=${rows[0].c}`);
    const { rows: t } = await query('SELECT title FROM jobs WHERE external_id = ? AND company_id = ?', ['job-7', cid]);
    assert.strictEqual(t[0].title, 'Updated 7', `title=${t[0].title}`);
  });

  // 3. The case that breaks a naive multi-row upsert: the same conflict key twice
  //    in ONE statement. Postgres raises "cannot affect row a second time".
  await check('duplicate external_id in one batch does not error (last wins)', async () => {
    const res = await jobsRepo.syncForCompany(cid, 'greenhouse', [
      mk(1000, { title: 'First' }),
      mk(1000, { title: 'Second' }),
      mk(1001),
    ]);
    assert.strictEqual(res.added, 2, `added=${res.added}`);
    const { rows } = await query('SELECT title FROM jobs WHERE external_id = ? AND company_id = ?', ['job-1000', cid]);
    assert.strictEqual(rows.length, 1, `rows=${rows.length}`);
    assert.strictEqual(rows[0].title, 'Second', `title=${rows[0].title}`);
  });

  // 4. description = COALESCE(EXCLUDED.description, jobs.description): a null in a
  //    later sync must NOT wipe a description we already have.
  await check('null description preserves the stored one', async () => {
    await jobsRepo.syncForCompany(cid, 'greenhouse', [mk(2000, { description: 'Full text' })]);
    await jobsRepo.syncForCompany(cid, 'greenhouse', [mk(2000, { description: null })]);
    const { rows } = await query('SELECT description FROM jobs WHERE external_id = ? AND company_id = ?', ['job-2000', cid]);
    assert.strictEqual(rows[0].description, 'Full text', `description=${rows[0].description}`);
  });

  // 5. visa_sponsorship / experience_level keep their value when the new one is ''.
  await check('empty enrichment fields do not overwrite stored values', async () => {
    await jobsRepo.syncForCompany(cid, 'greenhouse', [mk(3000, { visa_sponsorship: 'yes', experience_level: 'senior' })]);
    await jobsRepo.syncForCompany(cid, 'greenhouse', [mk(3000)]);
    const { rows } = await query(
      'SELECT visa_sponsorship, experience_level FROM jobs WHERE external_id = ? AND company_id = ?', ['job-3000', cid]);
    assert.strictEqual(rows[0].visa_sponsorship, 'yes', `visa=${rows[0].visa_sponsorship}`);
    assert.strictEqual(rows[0].experience_level, 'senior', `level=${rows[0].experience_level}`);
  });

  // 5b. The bug that erased an 18.5-hour backfill: an ATS whose list response has no
  //     salary passes NULL every sync, which used to overwrite a backfilled value.
  await check('null salary does not erase a backfilled one', async () => {
    await jobsRepo.syncForCompany(cid, 'greenhouse', [mk(3500)]);
    await query('UPDATE jobs SET salary_min = ?, salary_max = ?, salary_currency = ?, salary_interval = ? WHERE external_id = ? AND company_id = ?',
      ['90000', '120000', 'USD', 'year', 'job-3500', cid]);
    await jobsRepo.syncForCompany(cid, 'greenhouse', [mk(3500)]); // adapter supplies no salary
    const { rows } = await query('SELECT salary_min, salary_max, salary_currency, salary_interval FROM jobs WHERE external_id = ? AND company_id = ?', ['job-3500', cid]);
    assert.strictEqual(String(rows[0].salary_min), '90000', `salary_min=${rows[0].salary_min}`);
    assert.strictEqual(String(rows[0].salary_max), '120000', `salary_max=${rows[0].salary_max}`);
    assert.strictEqual(rows[0].salary_currency, 'USD', `currency=${rows[0].salary_currency}`);
    assert.strictEqual(rows[0].salary_interval, 'year', `interval=${rows[0].salary_interval}`);
  });

  // 5c. But a real incoming salary must still update.
  await check('incoming salary still overwrites', async () => {
    await jobsRepo.syncForCompany(cid, 'greenhouse', [mk(3600, { salary_min: '10', salary_max: '20' })]);
    await jobsRepo.syncForCompany(cid, 'greenhouse', [mk(3600, { salary_min: '55', salary_max: '75' })]);
    const { rows } = await query('SELECT salary_min, salary_max FROM jobs WHERE external_id = ? AND company_id = ?', ['job-3600', cid]);
    assert.strictEqual(String(rows[0].salary_min), '55', `salary_min=${rows[0].salary_min}`);
    assert.strictEqual(String(rows[0].salary_max), '75', `salary_max=${rows[0].salary_max}`);
  });

  // 6. A previously removed job comes back (removed_at = NULL) on re-sync.
  await check('re-syncing a removed job revives it', async () => {
    await jobsRepo.syncForCompany(cid, 'greenhouse', [mk(4000)]);
    await query("UPDATE jobs SET removed_at = NOW_FN WHERE external_id = ? AND company_id = ?"
      .replace('NOW_FN', process.env.DATABASE_URL ? 'NOW()' : "datetime('now')"), ['job-4000', cid]);
    await jobsRepo.syncForCompany(cid, 'greenhouse', [mk(4000)]);
    const { rows } = await query('SELECT removed_at FROM jobs WHERE external_id = ? AND company_id = ?', ['job-4000', cid]);
    assert.strictEqual(rows[0].removed_at, null, `removed_at=${rows[0].removed_at}`);
  });

  // 7. Empty list must be a no-op, not a malformed "VALUES ()".
  await check('empty incoming list is a no-op', async () => {
    const res = await jobsRepo.syncForCompany(cid, 'greenhouse', []);
    assert.strictEqual(res.added, 0);
    assert.strictEqual(res.updated, 0);
  });

  // 8. Timing signal: this is the whole point of the change.
  const N = 1000;
  const bulk = Array.from({ length: N }, (_, i) => mk(50000 + i));
  const t0 = Date.now();
  await jobsRepo.syncForCompany(cid, 'greenhouse', bulk);
  console.log(`  ${N} jobs synced in ${Date.now() - t0}ms (${dialect})`);

  await closeDb();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
