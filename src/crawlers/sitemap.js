const logger = require('../logger');

const SITEMAP_URLS = {
  greenhouse: 'https://boards.greenhouse.io/sitemap.xml',
  ashby: 'https://jobs.ashbyhq.com/sitemap.xml',
  lever: 'https://jobs.lever.co/sitemap.xml',
  smartrecruiters: 'https://jobs.smartrecruiters.com/sitemap.xml',
};

const SLUG_EXTRACTORS = {
  greenhouse: /boards\.greenhouse\.io\/([a-z0-9_-]+)/gi,
  ashby: /jobs\.ashbyhq\.com\/([a-z0-9_-]+)/gi,
  lever: /jobs\.lever\.co\/([a-z0-9_-]+)/gi,
  smartrecruiters: /jobs\.smartrecruiters\.com\/([a-z0-9_-]+)/gi,
};

const IGNORE_SLUGS = new Set([
  'www', 'api', 'app', 'cdn', 'js', 'css', 'docs', 'support', 'help',
  'about', 'blog', 'careers', 'embed', 'static', 'assets', 'login',
  'sitemap', 'robots', 'favicon',
]);

/**
 * Crawl ATS platform sitemaps to discover company slugs.
 */
async function crawlSitemaps() {
  const allResults = [];

  for (const [ats, sitemapUrl] of Object.entries(SITEMAP_URLS)) {
    try {
      logger.info({ ats, sitemapUrl }, 'Fetching sitemap');

      const res = await fetch(sitemapUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        logger.warn({ ats, status: res.status }, 'Sitemap not available');
        continue;
      }

      const xml = await res.text();
      const discovered = new Set();
      const regex = new RegExp(SLUG_EXTRACTORS[ats].source, 'gi');
      let match;

      while ((match = regex.exec(xml)) !== null) {
        const slug = match[1].toLowerCase();
        if (!IGNORE_SLUGS.has(slug) && slug.length > 1 && !discovered.has(slug)) {
          discovered.add(slug);
          allResults.push({ ats, slug });
        }
      }

      logger.info({ ats, count: discovered.size }, 'Sitemap crawl complete');
    } catch (err) {
      logger.warn({ ats, err: err.message }, 'Sitemap crawl failed');
    }
  }

  logger.info({ total: allResults.length }, 'All sitemap crawls complete');
  return allResults;
}

module.exports = { crawlSitemaps };
