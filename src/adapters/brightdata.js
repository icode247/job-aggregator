const config = require('../config');
const logger = require('../logger');

async function fetchUnlockedHtml(url) {
  if (!config.BRIGHT_DATA_API_KEY) {
    throw new Error('BRIGHT_DATA_API_KEY is not configured');
  }

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

module.exports = { fetchUnlockedHtml };
