const { getDb } = require('../connection');
const logger = require('../../logger');

const jobsRepo = {
  findActive({ companyId, ats, limit, offset } = {}) {
    let sql = 'SELECT j.*, c.domain, c.ats_slug, c.company_name, c.logo_url FROM jobs j JOIN companies c ON j.company_id = c.id WHERE j.removed_at IS NULL';
    const params = [];

    if (companyId) {
      sql += ' AND j.company_id = ?';
      params.push(companyId);
    }
    if (ats) {
      sql += ' AND j.ats = ?';
      params.push(ats);
    }

    sql += ' ORDER BY j.first_seen_at DESC';

    if (limit) {
      sql += ' LIMIT ?';
      params.push(limit);
      if (offset) {
        sql += ' OFFSET ?';
        params.push(offset);
      }
    }

    return getDb().prepare(sql).all(...params);
  },

  countActive({ companyId, ats } = {}) {
    let sql = 'SELECT COUNT(*) as count FROM jobs WHERE removed_at IS NULL';
    const params = [];
    if (companyId) { sql += ' AND company_id = ?'; params.push(companyId); }
    if (ats) { sql += ' AND ats = ?'; params.push(ats); }
    return getDb().prepare(sql).get(...params).count;
  },

  findById(id) {
    return getDb().prepare(`
      SELECT j.*, c.domain, c.ats_slug, c.company_name, c.logo_url FROM jobs j
      JOIN companies c ON j.company_id = c.id
      WHERE j.id = ?
    `).get(id);
  },

  /**
   * Sync jobs for a company: insert new, update existing, soft-delete removed.
   * Returns { added, updated, removed } counts.
   */
  syncForCompany(companyId, ats, incomingJobs) {
    const db = getDb();
    let added = 0;
    let updated = 0;
    let removed = 0;

    const syncTransaction = db.transaction(() => {
      // Get current active jobs for this company
      const existingJobs = db.prepare(
        'SELECT id, external_id FROM jobs WHERE company_id = ? AND removed_at IS NULL'
      ).all(companyId);

      const existingMap = new Map(existingJobs.map(j => [j.external_id, j.id]));
      const incomingIds = new Set(incomingJobs.map(j => j.external_id));

      // Upsert incoming jobs
      const upsertStmt = db.prepare(`
        INSERT INTO jobs (
          external_id, company_id, ats, title, department, location,
          workplace_type, employment_type,
          salary_min, salary_max, salary_currency, salary_interval,
          description, url, posted_at, raw_data,
          first_seen_at, last_seen_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(external_id, company_id) DO UPDATE SET
          title = excluded.title,
          department = excluded.department,
          location = excluded.location,
          workplace_type = excluded.workplace_type,
          employment_type = excluded.employment_type,
          salary_min = excluded.salary_min,
          salary_max = excluded.salary_max,
          salary_currency = excluded.salary_currency,
          salary_interval = excluded.salary_interval,
          description = excluded.description,
          url = excluded.url,
          posted_at = excluded.posted_at,
          raw_data = excluded.raw_data,
          last_seen_at = datetime('now'),
          removed_at = NULL
      `);

      for (const job of incomingJobs) {
        const result = upsertStmt.run(
          job.external_id, companyId, ats,
          job.title, job.department || null, job.location,
          job.workplace_type || null, job.employment_type || null,
          job.salary_min || null, job.salary_max || null,
          job.salary_currency || null, job.salary_interval || null,
          job.description || null, job.url, job.posted_at || null,
          JSON.stringify(job.raw_data || null)
        );
        if (existingMap.has(job.external_id)) {
          updated++;
        } else {
          added++;
        }
      }

      // Soft-delete jobs no longer in the API response
      const removeStmt = db.prepare(
        "UPDATE jobs SET removed_at = datetime('now') WHERE id = ?"
      );
      for (const [externalId, dbId] of existingMap) {
        if (!incomingIds.has(externalId)) {
          removeStmt.run(dbId);
          removed++;
        }
      }
    });

    syncTransaction();

    logger.info({ companyId, added, updated, removed }, 'Job sync diff complete');
    return { added, updated, removed };
  },
};

module.exports = jobsRepo;
