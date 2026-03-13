const path = require('path');

module.exports = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT, 10) || 3000,

  // Database
  DATABASE_PATH: process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'jobs.db'),

  // Redis
  REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',

  // Bright Data
  BRIGHT_DATA_API_KEY: process.env.BRIGHT_DATA_API_KEY || '',
  BRIGHT_DATA_ZONE: process.env.BRIGHT_DATA_ZONE || 'web_unlocker1',

  // Queue settings
  DISCOVERY_INTERVAL_MS: 1000 * 60 * 60 * 24 * 7, // 7 days
  SYNC_INTERVAL_MS: 1000 * 60 * 60 * 2,           // 2 hours
  DISCOVERY_RATE_LIMIT: { max: 5, duration: 60000 },
  SYNC_RATE_LIMIT: { max: 10, duration: 60000 },

  // Crawl settings
  CRAWL_RATE_LIMIT: { max: 3, duration: 60000 },
  CRAWL_INTERVAL_MS: 1000 * 60 * 60 * 24 * 30, // 30 days
  CRAWL_GOOGLE_MAX_PAGES: parseInt(process.env.CRAWL_GOOGLE_MAX_PAGES, 10) || 5,
  CRAWL_DICTIONARY_PATH: process.env.CRAWL_DICTIONARY_PATH || path.join(__dirname, '..', 'data', 'company-names.txt'),
};
