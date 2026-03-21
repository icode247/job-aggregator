const config = require('../config');
const logger = require('../logger');

/**
 * Browserless /content API — renders JS and returns full HTML.
 * Uses 1 unit per request. Max 2 concurrent (free), 1 min session timeout.
 * We set waitForSelector to wait for content to render before returning.
 */
async function fetchViaBrowserless(url, token, label) {
  logger.info({ url }, `Fetching HTML via Browserless (${label})`);

  const response = await fetch(
    `https://production-sfo.browserless.io/content?token=${token}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        gotoOptions: { waitUntil: 'networkidle2', timeout: 45000 },
        // Wait for body to have content (handles SPAs)
        waitForSelector: { selector: 'body', timeout: 30000 },
      }),
      signal: AbortSignal.timeout(55000),
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Browserless (${label}) HTTP ${response.status}: ${body.slice(0, 200)}`);
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

/**
 * Fetch rendered HTML via proxy chain:
 * 1. Browserless Free (1K units/mo, $0)
 * 2. ScraperAPI (pay-as-you-go)
 * 3. Browserless Paid (20K units/mo, $35)
 * 4. Bright Data (last resort, if configured)
 */
async function fetchUnlockedHtml(url) {
  // 1. Browserless Free
  if (config.BROWSERLESS_FREE_TOKEN) {
    try {
      return await fetchViaBrowserless(url, config.BROWSERLESS_FREE_TOKEN, 'free');
    } catch (err) {
      logger.debug({ url, err: err.message }, 'Browserless free failed');
    }
  }

  // 2. ScraperAPI
  if (config.SCRAPER_API_KEY) {
    try {
      return await fetchViaScraperAPI(url);
    } catch (err) {
      logger.debug({ url, err: err.message }, 'ScraperAPI failed');
    }
  }

  // 3. Browserless Paid
  if (config.BROWSERLESS_PAID_TOKEN) {
    try {
      return await fetchViaBrowserless(url, config.BROWSERLESS_PAID_TOKEN, 'paid');
    } catch (err) {
      logger.debug({ url, err: err.message }, 'Browserless paid failed');
    }
  }

  // 4. Bright Data (legacy fallback)
  if (config.BRIGHT_DATA_API_KEY) {
    return await fetchViaBrightData(url);
  }

  throw new Error('No proxy service configured');
}

module.exports = { fetchUnlockedHtml };
