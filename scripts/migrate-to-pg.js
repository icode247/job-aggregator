/**
 * Migrate data from local SQLite to Heroku PostgreSQL.
 * Usage: DATABASE_URL=postgres://... node scripts/migrate-to-pg.js
 */
const Database = require('better-sqlite3');
const { Pool } = require('pg');
const path = require('path');

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'jobs.db');
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required. Set it to your Heroku Postgres URL.');
  process.exit(1);
}

const sqlite = new Database(SQLITE_PATH);
const pg = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  console.log('Connected to SQLite:', SQLITE_PATH);
  console.log('Connected to PostgreSQL');

  // Create schema on PG
  await pg.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      career_url TEXT NOT NULL UNIQUE,
      domain TEXT NOT NULL,
      ats TEXT,
      ats_slug TEXT,
      status TEXT DEFAULT 'pending',
      last_discovered_at TIMESTAMP,
      last_synced_at TIMESTAMP,
      error_message TEXT,
      company_name TEXT,
      logo_url TEXT,
      origin TEXT DEFAULT 'seed',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pg.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id SERIAL PRIMARY KEY,
      external_id TEXT NOT NULL,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      ats TEXT NOT NULL,
      title TEXT NOT NULL,
      department TEXT,
      location TEXT,
      workplace_type TEXT,
      employment_type TEXT,
      salary_min INTEGER,
      salary_max INTEGER,
      salary_currency TEXT,
      salary_interval TEXT,
      description TEXT,
      url TEXT,
      posted_at TIMESTAMP,
      raw_data TEXT,
      first_seen_at TIMESTAMP DEFAULT NOW(),
      last_seen_at TIMESTAMP DEFAULT NOW(),
      removed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(external_id, company_id)
    )
  `);

  await pg.query(`
    CREATE TABLE IF NOT EXISTS crawl_sources (
      id SERIAL PRIMARY KEY,
      ats TEXT NOT NULL,
      slug TEXT NOT NULL,
      source TEXT NOT NULL,
      crawl_run TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(ats, slug)
    )
  `);

  // Create indexes
  await pg.query('CREATE INDEX IF NOT EXISTS idx_jobs_company_id ON jobs(company_id)');
  await pg.query('CREATE INDEX IF NOT EXISTS idx_jobs_external_id ON jobs(external_id)');
  await pg.query('CREATE INDEX IF NOT EXISTS idx_jobs_removed_at ON jobs(removed_at)');
  await pg.query('CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status)');
  await pg.query('CREATE INDEX IF NOT EXISTS idx_crawl_sources_ats ON crawl_sources(ats)');

  console.log('PG schema created');

  // Migrate companies
  const companies = sqlite.prepare('SELECT * FROM companies').all();
  console.log(`Migrating ${companies.length} companies...`);

  for (const c of companies) {
    await pg.query(
      `INSERT INTO companies (id, career_url, domain, ats, ats_slug, status, last_discovered_at, last_synced_at, error_message, company_name, logo_url, origin, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT(career_url) DO NOTHING`,
      [c.id, c.career_url, c.domain, c.ats, c.ats_slug, c.status,
       c.last_discovered_at, c.last_synced_at, c.error_message,
       c.company_name, c.logo_url, c.origin || 'seed',
       c.created_at, c.updated_at]
    );
  }

  // Reset sequence to max id
  if (companies.length > 0) {
    const maxId = Math.max(...companies.map(c => c.id));
    await pg.query(`SELECT setval('companies_id_seq', $1)`, [maxId]);
  }

  console.log(`Companies migrated: ${companies.length}`);

  // Migrate jobs
  const jobCount = sqlite.prepare('SELECT COUNT(*) as count FROM jobs').get().count;
  console.log(`Migrating ${jobCount} jobs...`);

  const batchSize = 100;
  let offset = 0;

  while (offset < jobCount) {
    const jobs = sqlite.prepare('SELECT * FROM jobs ORDER BY id LIMIT ? OFFSET ?').all(batchSize, offset);

    for (const j of jobs) {
      await pg.query(
        `INSERT INTO jobs (id, external_id, company_id, ats, title, department, location, workplace_type, employment_type,
         salary_min, salary_max, salary_currency, salary_interval, description, url, posted_at, raw_data,
         first_seen_at, last_seen_at, removed_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         ON CONFLICT(external_id, company_id) DO NOTHING`,
        [j.id, j.external_id, j.company_id, j.ats, j.title, j.department, j.location,
         j.workplace_type, j.employment_type, j.salary_min, j.salary_max,
         j.salary_currency, j.salary_interval, j.description, j.url, j.posted_at,
         j.raw_data, j.first_seen_at, j.last_seen_at, j.removed_at, j.created_at]
      );
    }

    offset += batchSize;
    process.stdout.write(`\r  ${Math.min(offset, jobCount)}/${jobCount} jobs migrated`);
  }

  // Reset sequence
  if (jobCount > 0) {
    const maxJobId = sqlite.prepare('SELECT MAX(id) as m FROM jobs').get().m;
    await pg.query(`SELECT setval('jobs_id_seq', $1)`, [maxJobId]);
  }

  console.log('\nJobs migrated');

  // Migrate crawl_sources
  try {
    const sources = sqlite.prepare('SELECT * FROM crawl_sources').all();
    for (const s of sources) {
      await pg.query(
        `INSERT INTO crawl_sources (ats, slug, source, crawl_run, created_at)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT(ats, slug) DO NOTHING`,
        [s.ats, s.slug, s.source, s.crawl_run, s.created_at]
      );
    }
    console.log(`Crawl sources migrated: ${sources.length}`);
  } catch {
    console.log('No crawl_sources table in SQLite (skipped)');
  }

  console.log('\nMigration complete!');

  sqlite.close();
  await pg.end();
}

main().catch(err => { console.error(err); process.exit(1); });
