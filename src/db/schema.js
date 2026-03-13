const { exec, query, isPostgres } = require('./connection');
const logger = require('../logger');

async function migrate() {
  const autoId = isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const now = isPostgres ? 'NOW()' : "datetime('now')";

  await exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id                 ${autoId},
      career_url         TEXT NOT NULL UNIQUE,
      domain             TEXT NOT NULL,
      ats                TEXT,
      ats_slug           TEXT,
      status             TEXT DEFAULT 'pending',
      last_discovered_at TIMESTAMP,
      last_synced_at     TIMESTAMP,
      error_message      TEXT,
      company_name       TEXT,
      logo_url           TEXT,
      origin             TEXT DEFAULT 'seed',
      created_at         TIMESTAMP DEFAULT ${now},
      updated_at         TIMESTAMP DEFAULT ${now}
    )
  `);

  await exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id              ${autoId},
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
      posted_at       TIMESTAMP,
      raw_data        TEXT,
      first_seen_at   TIMESTAMP DEFAULT ${now},
      last_seen_at    TIMESTAMP DEFAULT ${now},
      removed_at      TIMESTAMP,
      created_at      TIMESTAMP DEFAULT ${now},
      UNIQUE(external_id, company_id)
    )
  `);

  await exec('CREATE INDEX IF NOT EXISTS idx_jobs_company_id ON jobs(company_id)');
  await exec('CREATE INDEX IF NOT EXISTS idx_jobs_external_id ON jobs(external_id)');
  await exec('CREATE INDEX IF NOT EXISTS idx_jobs_removed_at ON jobs(removed_at)');
  await exec('CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status)');

  await exec(`
    CREATE TABLE IF NOT EXISTS crawl_sources (
      id          ${autoId},
      ats         TEXT NOT NULL,
      slug        TEXT NOT NULL,
      source      TEXT NOT NULL,
      crawl_run   TEXT,
      created_at  TIMESTAMP DEFAULT ${now},
      UNIQUE(ats, slug)
    )
  `);

  await exec('CREATE INDEX IF NOT EXISTS idx_crawl_sources_ats ON crawl_sources(ats)');

  logger.info({ engine: isPostgres ? 'postgresql' : 'sqlite' }, 'Database schema migrated');
}

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { migrate };
