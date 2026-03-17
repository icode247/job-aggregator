const config = require('../config');
const logger = require('../logger');

async function sendAlert(title, message, level = 'warning') {
  const webhookUrl = config.ALERT_WEBHOOK_URL;
  if (!webhookUrl) return;

  const emoji = level === 'error' ? '\uD83D\uDD34' : level === 'warning' ? '\uD83D\uDFE1' : '\u2139\uFE0F';
  const payload = {
    text: `${emoji} *${title}*\n${message}`,
    // Slack-compatible format
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `${emoji} ${title}` } },
      { type: 'section', text: { type: 'mrkdwn', text: message } },
    ],
  };

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to send alert webhook');
  }
}

module.exports = { sendAlert };
