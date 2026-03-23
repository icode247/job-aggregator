const config = require('../config');
const logger = require('../logger');

/**
 * Circuit breaker: skip providers that return 401 (quota/auth) for the rest of the process lifetime.
 * 429 (rate limit) is transient so we don't circuit-break on it.
 */
const disabledProviders = new Set();

/**
 * Concurrency limiter for Browserless Paid (max 5 concurrent browsers).
 * Callers wait in a queue instead of hammering the API and getting 429.
 */
const BROWSERLESS_PAID_MAX_CONCURRENT = 5;
let browserlessPaidActive = 0;
const browserlessPaidQueue = [];

function acquireBrowserlessSlot() {
  if (browserlessPaidActive < BROWSERLESS_PAID_MAX_CONCURRENT) {
    browserlessPaidActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => browserlessPaidQueue.push(resolve));
}

function releaseBrowserlessSlot() {
  if (browserlessPaidQueue.length > 0) {
    const next = browserlessPaidQueue.shift();
    next();
  } else {
    browserlessPaidActive--;
  }
}

/**
 * Browserless /content API — renders JS and returns full HTML.
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
 * 3. Browserless Paid (20K units/mo, $35) — capped at 5 concurrent
 *
 * Circuit breaker: 401 disables a provider for the rest of the process.
 * 429 is transient and retried next cycle.
 */
async function fetchUnlockedHtml(url) {
  let tried = 0;

  // 1. Browserless Free
  if (config.BROWSERLESS_FREE_TOKEN && !disabledProviders.has('browserless-free')) {
    tried++;
    try {
      return await fetchViaBrowserless(url, config.BROWSERLESS_FREE_TOKEN, 'free');
    } catch (err) {
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
      if (err.status === 401) {
        disabledProviders.add('scraperapi');
        logger.warn('ScraperAPI: 401 auth — disabled for this session');
      } else {
        logger.debug({ url: url.slice(0, 100), err: err.message }, 'ScraperAPI failed');
      }
    }
  }

  // 3. Browserless Paid — wait for a slot (max 5 concurrent)
  if (config.BROWSERLESS_PAID_TOKEN && !disabledProviders.has('browserless-paid')) {
    tried++;
    await acquireBrowserlessSlot();
    try {
      return await fetchViaBrowserless(url, config.BROWSERLESS_PAID_TOKEN, 'paid');
    } catch (err) {
      if (err.status === 401) {
        disabledProviders.add('browserless-paid');
        logger.warn('Browserless paid: 401 quota/auth — disabled for this session');
      } else {
        logger.debug({ url: url.slice(0, 100), err: err.message }, 'Browserless paid failed');
      }
    } finally {
      releaseBrowserlessSlot();
    }
  }

  throw new Error(tried === 0 ? 'All proxy providers disabled or unconfigured' : `All ${tried} proxy providers failed`);
}

module.exports = { fetchUnlockedHtml };
