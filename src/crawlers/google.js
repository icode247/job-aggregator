const config = require('../config');
const logger = require('../logger');
const { fetchUnlockedHtml } = require('../adapters/brightdata');

const ATS_SEARCH_QUERIES = {
  greenhouse:      { query: 'site:boards.greenhouse.io',       regex: /boards\.greenhouse\.io\/([a-z0-9_-]+)/gi },
  lever:           { query: 'site:jobs.lever.co',              regex: /jobs\.lever\.co\/([a-z0-9_-]+)/gi },
  ashby:           { query: 'site:jobs.ashbyhq.com',           regex: /jobs\.ashbyhq\.com\/([a-z0-9_-]+)/gi },
  workable:        { query: 'site:apply.workable.com',         regex: /apply\.workable\.com\/([a-z0-9_-]+)/gi },
  recruitee:       { query: 'site:*.recruitee.com',            regex: /([a-z0-9_-]+)\.recruitee\.com/gi },
  smartrecruiters: { query: 'site:jobs.smartrecruiters.com',   regex: /jobs\.smartrecruiters\.com\/([a-z0-9_-]+)/gi },
  rippling:        { query: 'site:ats.rippling.com',           regex: /ats\.rippling\.com\/([a-z0-9_-]+)/gi },
  jobvite:         { query: 'site:jobs.jobvite.com',           regex: /jobs\.jobvite\.com\/([a-z0-9_-]+)/gi },
  pinpoint:        { query: 'site:pinpointhq.com',            regex: /([a-z0-9_-]+)\.pinpointhq\.com/gi },
};

const IGNORE_SLUGS = new Set([
  'www', 'api', 'app', 'cdn', 'js', 'css', 'docs', 'support', 'help',
  'about', 'blog', 'careers', 'embed', 'static', 'assets', 'login',
  'signup', 'register', 'admin', 'status', 'undefined', 'null',
  'jobs', 'xml', 'en', 'de', 'fr', 'apply', 'posting', 'postings',
]);

/**
 * Crawl Google search results via proxy chain to discover company slugs for a given ATS.
 * Returns an array of { ats, slug }.
 */
async function crawlGoogle(ats, maxPages = 5) {
  const atsConfig = ATS_SEARCH_QUERIES[ats];
  if (!atsConfig) throw new Error(`Unknown ATS for Google crawl: ${ats}`);

  const discovered = new Set();
  const results = [];

  for (let page = 0; page < maxPages; page++) {
    const start = page * 100;
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(atsConfig.query)}&start=${start}&num=100`;

    logger.info({ ats, page, start }, 'Fetching Google SERP page');

    try {
      const html = await fetchUnlockedHtml(searchUrl);

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
