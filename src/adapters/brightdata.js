const config = require('../config');
const logger = require('../logger');

async function fetchViaBrightData(url) {
  logger.info({ url }, 'Fetching HTML via Bright Data');

  const response = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.BRIGHT_DATA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      zone: config.BRIGHT_DATA_ZONE,
      url,
      format: 'raw',
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Bright Data HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.text();
}

async function fetchViaScraperAPI(url) {
  logger.info({ url }, 'Fetching HTML via ScraperAPI');

  const apiUrl = `https://api.scraperapi.com?api_key=${config.SCRAPER_API_KEY}&url=${encodeURIComponent(url)}&render=true`;
  const response = await fetch(apiUrl, {
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`ScraperAPI HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.text();
}

/**
 * Fetch HTML via proxy service. Tries ScraperAPI first (if configured),
 * then falls back to Bright Data.
 */
async function fetchUnlockedHtml(url) {
  // Try ScraperAPI first
  if (config.SCRAPER_API_KEY) {
    try {
      return await fetchViaScraperAPI(url);
    } catch (err) {
      logger.debug({ url, err: err.message }, 'ScraperAPI failed, trying Bright Data');
    }
  }

  // Fall back to Bright Data
  if (config.BRIGHT_DATA_API_KEY) {
    return await fetchViaBrightData(url);
  }

  throw new Error('No proxy service configured (SCRAPER_API_KEY or BRIGHT_DATA_API_KEY)');
}

module.exports = { fetchUnlockedHtml };
