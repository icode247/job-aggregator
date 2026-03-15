const { query } = require('../connection');

const companiesRepo = {
  async findAll() {
    const { rows } = await query('SELECT * FROM companies ORDER BY id');
    return rows;
  },

  async findPending() {
    const { rows } = await query("SELECT * FROM companies WHERE status = 'pending' AND ats IS NULL");
    return rows;
  },

  async findActive() {
    const { rows } = await query("SELECT * FROM companies WHERE status = 'active'");
    return rows;
  },

  async findById(id) {
    const { rows } = await query('SELECT * FROM companies WHERE id = ?', [id]);
    return rows[0] || null;
  },

  async findByUrl(careerUrl) {
    const { rows } = await query('SELECT * FROM companies WHERE career_url = ?', [careerUrl]);
    return rows[0] || null;
  },

  async create({ careerUrl, domain }) {
    const { rowCount, lastId } = await query(
      'INSERT INTO companies (career_url, domain) VALUES (?, ?) ON CONFLICT(career_url) DO NOTHING',
      [careerUrl, domain]
    );
    if (rowCount === 0) return this.findByUrl(careerUrl);
    return this.findById(lastId);
  },

  async updateDiscovery(id, { ats, atsSlug }) {
    await query(
      `UPDATE companies SET ats = ?, ats_slug = ?, status = 'active',
       last_discovered_at = datetime('now'), updated_at = datetime('now'), error_message = NULL
       WHERE id = ?`,
      [ats, atsSlug, id]
    );
  },

  async updateMeta(id, { companyName, logoUrl }) {
    const sets = [];
    const params = [];
    if (companyName) { sets.push('company_name = ?'); params.push(companyName); }
    if (logoUrl) { sets.push('logo_url = ?'); params.push(logoUrl); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    params.push(id);
    await query(`UPDATE companies SET ${sets.join(', ')} WHERE id = ?`, params);
  },

  async markUnsupported(id) {
    await query(
      "UPDATE companies SET status = 'unsupported', last_discovered_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      [id]
    );
  },

  async markFailed(id, errorMessage) {
    await query(
      "UPDATE companies SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?",
      [errorMessage, id]
    );
  },

  async updateLastSynced(id) {
    await query(
      "UPDATE companies SET last_synced_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      [id]
    );
  },

  async findByAtsAndSlug(ats, slug) {
    const { rows } = await query('SELECT * FROM companies WHERE ats = ? AND ats_slug = ?', [ats, slug]);
    return rows[0] || null;
  },

  async createFromCrawl({ ats, atsSlug, origin }) {
    const boardUrls = {
      greenhouse: `https://boards.greenhouse.io/${atsSlug}`,
      lever: `https://jobs.lever.co/${atsSlug}`,
      ashby: `https://jobs.ashbyhq.com/${atsSlug}`,
      workable: `https://apply.workable.com/${atsSlug}`,
      recruitee: `https://${atsSlug}.recruitee.com`,
      smartrecruiters: `https://careers.smartrecruiters.com/${atsSlug}`,
      rippling: `https://ats.rippling.com/${atsSlug}`,
      personio: `https://${atsSlug}.jobs.personio.de`,
      breezy: `https://${atsSlug}.breezy.hr`,
      jazzhr: `https://app.jazz.co/widgets/basic/create/${atsSlug}`,
      workday: `https://${atsSlug}.myworkdayjobs.com`,
    };
    const careerUrl = boardUrls[ats] || `https://${atsSlug}.com/careers`;
    const domain = `${atsSlug}.com`;

    const { rowCount, lastId } = await query(
      `INSERT INTO companies (career_url, domain, ats, ats_slug, status, origin, last_discovered_at)
       VALUES (?, ?, ?, ?, 'active', ?, datetime('now'))
       ON CONFLICT(career_url) DO NOTHING`,
      [careerUrl, domain, ats, atsSlug, origin || 'crawl']
    );
    if (rowCount === 0) return this.findByUrl(careerUrl);
    return this.findById(lastId);
  },
};

module.exports = companiesRepo;
