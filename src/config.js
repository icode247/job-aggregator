const path = require('path');

module.exports = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT, 10) || 3000,

  // Database
  DATABASE_PATH: process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'jobs.db'),

  // Redis
  REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',

  // Auth
  API_SECRET: process.env.API_SECRET || '',

  // ScraperAPI
  SCRAPER_API_KEY: process.env.SCRAPER_API_KEY || '',

  // Browserless
  BROWSERLESS_FREE_TOKEN: process.env.BROWSERLESS_FREE_TOKEN || '',
  BROWSERLESS_PAID_TOKEN: process.env.BROWSERLESS_PAID_TOKEN || '',

  // Queue settings
  DISCOVERY_INTERVAL_MS: 1000 * 60 * 60 * 24 * 14, // 14 days
  SYNC_INTERVAL_MS: 1000 * 60 * 5,                 // 5 minutes (was 15)
  DISCOVERY_RATE_LIMIT: { max: 50, duration: 60000 },  // 50/min (was 10)
  SYNC_RATE_LIMIT: { max: 500, duration: 60000 },      // 500/min (was 300)

  // Crawl settings
  CRAWL_RATE_LIMIT: { max: 10, duration: 60000 },      // 10/min (was 6)
  CRAWL_INTERVAL_MS: 1000 * 60 * 60 * 24, // 1 day
  CRAWL_GOOGLE_MAX_PAGES: parseInt(process.env.CRAWL_GOOGLE_MAX_PAGES, 10) || 10,
  CRAWL_DICTIONARY_PATH: process.env.CRAWL_DICTIONARY_PATH || path.join(__dirname, '..', 'data', 'company-names.txt'),

  // Alerting (Telegram)
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || null,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || null,
};
