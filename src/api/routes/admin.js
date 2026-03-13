const { Router } = require('express');
const { companiesRepo, crawlSourcesRepo } = require('../../db');

const router = Router();

// POST /api/admin/crawl — trigger a crawl
router.post('/api/admin/crawl', async (req, res) => {
  const crawlQueue = req.app.get('crawlQueue');
  if (!crawlQueue) {
    return res.status(503).json({ error: 'Crawl queue not available (worker not connected)' });
  }

  const { strategy = 'all' } = req.body;
  const crawlRun = new Date().toISOString();

  if (strategy === 'all') {
    await crawlQueue.add('crawl-google-all', { strategy: 'google-all', crawlRun });
    await crawlQueue.add('crawl-dictionary', { strategy: 'dictionary', crawlRun });
    await crawlQueue.add('crawl-sitemap', { strategy: 'sitemap', crawlRun });
  } else {
    await crawlQueue.add(`crawl-${strategy}`, { strategy, crawlRun, ats: req.body.ats });
  }

  res.json({ status: 'queued', strategy, crawlRun });
});

// GET /api/admin/crawl/stats
router.get('/api/admin/crawl/stats', (req, res) => {
  const bySource = crawlSourcesRepo.countBySource();
  const total = crawlSourcesRepo.totalCount();
  const companies = companiesRepo.findAll().length;
  const active = companiesRepo.findActive().length;

  res.json({
    crawl_sources_total: total,
    by_source: bySource,
    companies_total: companies,
    companies_active: active,
  });
});

// POST /api/admin/companies — bulk add by domain
router.post('/api/admin/companies', async (req, res) => {
  const { domains } = req.body;
  if (!Array.isArray(domains) || domains.length === 0) {
    return res.status(400).json({ error: 'Provide an array of domains' });
  }

  const syncQueue = req.app.get('syncQueue');
  const added = [];

  for (const domain of domains) {
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    const company = companiesRepo.create({
      careerUrl: `https://${cleanDomain}/careers`,
      domain: cleanDomain,
    });

    if (company) {
      added.push({ id: company.id, domain: cleanDomain });
    }
  }

  res.json({ added: added.length, companies: added });
});

module.exports = router;
