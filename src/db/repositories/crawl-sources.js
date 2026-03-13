const { getDb } = require('../connection');

const crawlSourcesRepo = {
  /**
   * Insert a new crawl source. Returns true if it was new, false if already existed.
   */
  insertIfNew(ats, slug, source, crawlRun) {
    const result = getDb().prepare(
      'INSERT OR IGNORE INTO crawl_sources (ats, slug, source, crawl_run) VALUES (?, ?, ?, ?)'
    ).run(ats, slug, source, crawlRun);
    return result.changes > 0;
  },

  exists(ats, slug) {
    return !!getDb().prepare('SELECT 1 FROM crawl_sources WHERE ats = ? AND slug = ?').get(ats, slug);
  },

  countBySource() {
    return getDb().prepare(
      'SELECT source, ats, COUNT(*) as count FROM crawl_sources GROUP BY source, ats'
    ).all();
  },

  totalCount() {
    return getDb().prepare('SELECT COUNT(*) as count FROM crawl_sources').get().count;
  },
};

module.exports = crawlSourcesRepo;
