const { getDb } = require('../connection');

const companiesRepo = {
  findAll() {
    return getDb().prepare('SELECT * FROM companies ORDER BY id').all();
  },

  findActive() {
    return getDb().prepare("SELECT * FROM companies WHERE status = 'active'").all();
  },

  findById(id) {
    return getDb().prepare('SELECT * FROM companies WHERE id = ?').get(id);
  },

  findByUrl(careerUrl) {
    return getDb().prepare('SELECT * FROM companies WHERE career_url = ?').get(careerUrl);
  },

  create({ careerUrl, domain }) {
    const stmt = getDb().prepare(
      "INSERT INTO companies (career_url, domain) VALUES (?, ?) ON CONFLICT(career_url) DO NOTHING"
    );
    const result = stmt.run(careerUrl, domain);
    if (result.changes === 0) {
      return this.findByUrl(careerUrl);
    }
    return this.findById(result.lastInsertRowid);
  },

  updateDiscovery(id, { ats, atsSlug }) {
    getDb().prepare(`
      UPDATE companies
      SET ats = ?, ats_slug = ?, status = 'active',
          last_discovered_at = datetime('now'), updated_at = datetime('now'),
          error_message = NULL
      WHERE id = ?
    `).run(ats, atsSlug, id);
  },

  updateMeta(id, { companyName, logoUrl }) {
    const sets = [];
    const params = [];
    if (companyName) { sets.push('company_name = ?'); params.push(companyName); }
    if (logoUrl) { sets.push('logo_url = ?'); params.push(logoUrl); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    params.push(id);
    getDb().prepare(`UPDATE companies SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  },

  markUnsupported(id) {
    getDb().prepare(`
      UPDATE companies
      SET status = 'unsupported', last_discovered_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
  },

  markFailed(id, errorMessage) {
    getDb().prepare(`
      UPDATE companies
      SET status = 'failed', error_message = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(errorMessage, id);
  },

  updateLastSynced(id) {
    getDb().prepare(`
      UPDATE companies
      SET last_synced_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
  },

  findByAtsAndSlug(ats, slug) {
    return getDb().prepare('SELECT * FROM companies WHERE ats = ? AND ats_slug = ?').get(ats, slug);
  },

  createFromCrawl({ ats, atsSlug, origin }) {
    const boardUrls = {
      greenhouse: `https://boards.greenhouse.io/${atsSlug}`,
      lever: `https://jobs.lever.co/${atsSlug}`,
      ashby: `https://jobs.ashbyhq.com/${atsSlug}`,
      workable: `https://apply.workable.com/${atsSlug}`,
      recruitee: `https://${atsSlug}.recruitee.com`,
    };
    const careerUrl = boardUrls[ats] || `https://${atsSlug}.com/careers`;
    const domain = `${atsSlug}.com`;

    const stmt = getDb().prepare(`
      INSERT INTO companies (career_url, domain, ats, ats_slug, status, origin, last_discovered_at)
      VALUES (?, ?, ?, ?, 'active', ?, datetime('now'))
      ON CONFLICT(career_url) DO NOTHING
    `);
    const result = stmt.run(careerUrl, domain, ats, atsSlug, origin || 'crawl');
    if (result.changes === 0) {
      return this.findByUrl(careerUrl);
    }
    return this.findById(result.lastInsertRowid);
  },
};

module.exports = companiesRepo;
