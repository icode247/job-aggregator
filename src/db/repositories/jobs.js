const { query, transaction } = require('../connection');
const logger = require('../../logger');

const jobsRepo = {
  async findActive({ companyId, ats, limit, offset } = {}) {
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

    const { rows } = await query(sql, params);
    return rows;
  },

  async countActive({ companyId, ats } = {}) {
    let sql = 'SELECT COUNT(*) as count FROM jobs WHERE removed_at IS NULL';
    const params = [];
    if (companyId) { sql += ' AND company_id = ?'; params.push(companyId); }
    if (ats) { sql += ' AND ats = ?'; params.push(ats); }
    const { rows } = await query(sql, params);
    return parseInt(rows[0].count, 10);
  },

  async findById(id) {
    const { rows } = await query(
      `SELECT j.*, c.domain, c.ats_slug, c.company_name, c.logo_url FROM jobs j
       JOIN companies c ON j.company_id = c.id WHERE j.id = ?`,
      [id]
    );
    return rows[0] || null;
  },

  async syncForCompany(companyId, ats, incomingJobs) {
    let added = 0;
    let updated = 0;
    let removed = 0;

    await transaction(async (tx) => {
      const { rows: existingJobs } = await tx.query(
        'SELECT id, external_id FROM jobs WHERE company_id = ? AND removed_at IS NULL',
        [companyId]
      );

      const existingMap = new Map(existingJobs.map(j => [j.external_id, j.id]));
      const incomingIds = new Set(incomingJobs.map(j => j.external_id));

      for (const job of incomingJobs) {
        await tx.query(
          `INSERT INTO jobs (
            external_id, company_id, ats, title, department, location,
            workplace_type, employment_type,
            salary_min, salary_max, salary_currency, salary_interval,
            description, url, posted_at, raw_data,
            first_seen_at, last_seen_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(external_id, company_id) DO UPDATE SET
            title = EXCLUDED.title,
            department = EXCLUDED.department,
            location = EXCLUDED.location,
            workplace_type = EXCLUDED.workplace_type,
            employment_type = EXCLUDED.employment_type,
            salary_min = EXCLUDED.salary_min,
            salary_max = EXCLUDED.salary_max,
            salary_currency = EXCLUDED.salary_currency,
            salary_interval = EXCLUDED.salary_interval,
            description = EXCLUDED.description,
            url = EXCLUDED.url,
            posted_at = EXCLUDED.posted_at,
            raw_data = EXCLUDED.raw_data,
            last_seen_at = datetime('now'),
            removed_at = NULL`,
          [
            job.external_id, companyId, ats,
            job.title, job.department || null, job.location,
            job.workplace_type || null, job.employment_type || null,
            job.salary_min || null, job.salary_max || null,
            job.salary_currency || null, job.salary_interval || null,
            job.description || null, job.url, job.posted_at || null,
            JSON.stringify(job.raw_data || null),
          ]
        );
        if (existingMap.has(job.external_id)) {
          updated++;
        } else {
          added++;
        }
      }

      for (const [externalId, dbId] of existingMap) {
        if (!incomingIds.has(externalId)) {
          await tx.query("UPDATE jobs SET removed_at = datetime('now') WHERE id = ?", [dbId]);
          removed++;
        }
      }
    });

    logger.info({ companyId, added, updated, removed }, 'Job sync diff complete');
    return { added, updated, removed };
  },
};

module.exports = jobsRepo;
