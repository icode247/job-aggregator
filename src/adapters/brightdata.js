const config = require('../config');
const logger = require('../logger');

/**
 * Circuit breaker: skip providers that return 401 (quota/auth) for the rest of the process lifetime.
 * 429 (rate limit) is transient so we don't circuit-break on it.
 */
const disabledProviders = new Set();

/**
 * Browserless /content API — renders JS and returns full HTML.
 * Uses 1 unit per request. Max 2 concurrent (free), 1 min session timeout.
 */
async function fetchViaBrowserless(url, token, label) {
  const response = await fetch(
    `https://production-sfo.browserless.io/content?token=${token}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        gotoOptions: { waitUntil: 'networkidle2', timeout: 45000 },
        waitForSelector: { selector: 'body', timeout: 30000 },
      }),
      signal: AbortSignal.timeout(55000),
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`Browserless (${label}) HTTP ${response.status}: ${body.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  return response.text();
}

async function fetchViaScraperAPI(url) {
  const apiUrl = `https://api.scraperapi.com?api_key=${config.SCRAPER_API_KEY}&url=${encodeURIComponent(url)}&render=true`;
  const response = await fetch(apiUrl, {
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`ScraperAPI HTTP ${response.status}: ${body.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  return response.text();
}

/**
 * Fetch rendered HTML via proxy chain:
 * 1. Browserless Free (1K units/mo, $0)
 * 2. ScraperAPI (pay-as-you-go)
 * 3. Browserless Paid (20K units/mo, $35)
 *
 * Circuit breaker: 401 disables a provider for the rest of the process.
 * 429 is transient and retried next cycle.
 */
async function fetchUnlockedHtml(url) {
  let tried = 0;
  let lastErr = null;

  // 1. Browserless Free
  if (config.BROWSERLESS_FREE_TOKEN && !disabledProviders.has('browserless-free')) {
    tried++;
    try {
      return await fetchViaBrowserless(url, config.BROWSERLESS_FREE_TOKEN, 'free');
    } catch (err) {
      lastErr = err;
      if (err.status === 401) {
        disabledProviders.add('browserless-free');
        logger.warn('Browserless free: 401 quota/auth — disabled for this session');
      } else {
        logger.debug({ url: url.slice(0, 100), err: err.message }, 'Browserless free failed');
      }
    }
  }

  // 2. ScraperAPI
  if (config.SCRAPER_API_KEY && !disabledProviders.has('scraperapi')) {
    tried++;
    try {
      return await fetchViaScraperAPI(url);
    } catch (err) {
      lastErr = err;
      if (err.status === 401) {
        disabledProviders.add('scraperapi');
        logger.warn('ScraperAPI: 401 auth — disabled for this session');
      } else {
        logger.debug({ url: url.slice(0, 100), err: err.message }, 'ScraperAPI failed');
      }
    }
  }

  // 3. Browserless Paid
  if (config.BROWSERLESS_PAID_TOKEN && !disabledProviders.has('browserless-paid')) {
    tried++;
    try {
      return await fetchViaBrowserless(url, config.BROWSERLESS_PAID_TOKEN, 'paid');
    } catch (err) {
      lastErr = err;
      if (err.status === 401) {
        disabledProviders.add('browserless-paid');
        logger.warn('Browserless paid: 401 quota/auth — disabled for this session');
      } else {
        logger.debug({ url: url.slice(0, 100), err: err.message }, 'Browserless paid failed');
      }
    }
  }

  throw new Error(tried === 0 ? 'All proxy providers disabled or unconfigured' : `All ${tried} proxy providers failed`);
}

module.exports = { fetchUnlockedHtml };
