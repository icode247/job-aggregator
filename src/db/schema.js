const { getDb } = require('./connection');
const logger = require('../logger');

function migrate() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      career_url         TEXT NOT NULL UNIQUE,
      domain             TEXT NOT NULL,
      ats                TEXT,
      ats_slug           TEXT,
      status             TEXT DEFAULT 'pending',
      last_discovered_at TEXT,
      last_synced_at     TEXT,
      error_message      TEXT,
      created_at         TEXT DEFAULT (datetime('now')),
      updated_at         TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id     TEXT NOT NULL,
      company_id      INTEGER NOT NULL REFERENCES companies(id),
      ats             TEXT NOT NULL,
      title           TEXT NOT NULL,
      department      TEXT,
      location        TEXT,
      workplace_type  TEXT,
      employment_type TEXT,
      salary_min      INTEGER,
      salary_max      INTEGER,
      salary_currency TEXT,
      salary_interval TEXT,
      description     TEXT,
      url             TEXT,
      posted_at       TEXT,
      raw_data        TEXT,
      first_seen_at   TEXT DEFAULT (datetime('now')),
      last_seen_at    TEXT DEFAULT (datetime('now')),
      removed_at      TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      UNIQUE(external_id, company_id)
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_company_id ON jobs(company_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_external_id ON jobs(external_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_removed_at ON jobs(removed_at);
    CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);
  `);

  // Add new columns to existing tables (safe to re-run — silently fails if column exists)
  const newJobColumns = [
    ['department', 'TEXT'],
    ['workplace_type', 'TEXT'],
    ['employment_type', 'TEXT'],
    ['salary_min', 'INTEGER'],
    ['salary_max', 'INTEGER'],
    ['salary_currency', 'TEXT'],
    ['salary_interval', 'TEXT'],
    ['description', 'TEXT'],
    ['posted_at', 'TEXT'],
  ];
  for (const [col, type] of newJobColumns) {
    try { db.exec(`ALTER TABLE jobs ADD COLUMN ${col} ${type}`); } catch {}
  }

  // Company columns
  const newCompanyColumns = [
    ['company_name', 'TEXT'],
    ['logo_url', 'TEXT'],
    ['origin', 'TEXT'],
  ];
  for (const [col, type] of newCompanyColumns) {
    try { db.exec(`ALTER TABLE companies ADD COLUMN ${col} ${type}`); } catch {}
  }

  // Crawl sources table — tracks discovered slugs to avoid re-processing
  db.exec(`
    CREATE TABLE IF NOT EXISTS crawl_sources (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ats         TEXT NOT NULL,
      slug        TEXT NOT NULL,
      source      TEXT NOT NULL,
      crawl_run   TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(ats, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_crawl_sources_ats ON crawl_sources(ats);
  `);

  logger.info('Database schema migrated');
}

// Allow running directly: node src/db/schema.js
if (require.main === module) {
  migrate();
  process.exit(0);
}

module.exports = { migrate };
