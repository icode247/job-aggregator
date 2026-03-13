const config = require('../config');
const logger = require('../logger');

const ATS_SEARCH_QUERIES = {
  greenhouse:      { query: 'site:boards.greenhouse.io',       regex: /boards\.greenhouse\.io\/([a-z0-9_-]+)/gi },
  lever:           { query: 'site:jobs.lever.co',              regex: /jobs\.lever\.co\/([a-z0-9_-]+)/gi },
  ashby:           { query: 'site:jobs.ashbyhq.com',           regex: /jobs\.ashbyhq\.com\/([a-z0-9_-]+)/gi },
  workable:        { query: 'site:apply.workable.com',         regex: /apply\.workable\.com\/([a-z0-9_-]+)/gi },
  recruitee:       { query: 'site:*.recruitee.com',            regex: /([a-z0-9_-]+)\.recruitee\.com/gi },
  smartrecruiters: { query: 'site:jobs.smartrecruiters.com',   regex: /jobs\.smartrecruiters\.com\/([a-z0-9_-]+)/gi },
  rippling:        { query: 'site:ats.rippling.com',           regex: /ats\.rippling\.com\/([a-z0-9_-]+)/gi },
};

const IGNORE_SLUGS = new Set([
  'www', 'api', 'app', 'cdn', 'js', 'css', 'docs', 'support', 'help',
  'about', 'blog', 'careers', 'embed', 'static', 'assets', 'login',
  'signup', 'register', 'admin', 'status', 'undefined', 'null',
  'jobs', 'xml', 'en', 'de', 'fr', 'apply', 'posting', 'postings',
]);

/**
 * Crawl Google search results via Bright Data to discover company slugs for a given ATS.
 * Returns an array of { ats, slug }.
 */
async function crawlGoogle(ats, maxPages = 5) {
  const atsConfig = ATS_SEARCH_QUERIES[ats];
  if (!atsConfig) throw new Error(`Unknown ATS for Google crawl: ${ats}`);

  if (!config.BRIGHT_DATA_API_KEY) {
    throw new Error('BRIGHT_DATA_API_KEY is not configured');
  }

  const discovered = new Set();
  const results = [];

  for (let page = 0; page < maxPages; page++) {
    const start = page * 100;
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(atsConfig.query)}&start=${start}&num=100`;

    logger.info({ ats, page, start }, 'Fetching Google SERP page');

    try {
      const response = await fetch('https://api.brightdata.com/request', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.BRIGHT_DATA_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          zone: config.BRIGHT_DATA_ZONE,
          url: searchUrl,
          format: 'raw',
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logger.warn({ ats, page, status: response.status }, `SERP fetch failed: ${body.slice(0, 200)}`);
        break;
      }

      const html = await response.text();

      // Extract all slugs from the page
      let match;
      const regex = new RegExp(atsConfig.regex.source, 'gi');
      while ((match = regex.exec(html)) !== null) {
        const slug = match[1].toLowerCase();
        if (!IGNORE_SLUGS.has(slug) && slug.length > 1 && !discovered.has(slug)) {
          discovered.add(slug);
          results.push({ ats, slug });
        }
      }

      logger.info({ ats, page, newSlugs: discovered.size }, 'SERP page processed');

      // If we got fewer results than expected, we've exhausted results
      if (html.length < 5000) break;

      // Rate limit: wait between pages
      if (page < maxPages - 1) {
        await new Promise(r => setTimeout(r, 3000));
      }
    } catch (err) {
      logger.error({ ats, page, err: err.message }, 'Google crawl error');
      break;
    }
  }

  logger.info({ ats, totalDiscovered: results.length }, 'Google crawl complete');
  return results;
}

module.exports = { crawlGoogle, ATS_SEARCH_QUERIES };
