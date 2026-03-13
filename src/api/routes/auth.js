const { Router } = require('express');
const jwt = require('jsonwebtoken');
const config = require('../../config');

const router = Router();

/**
 * POST /api/auth/token
 *
 * Generate an API token using the master secret.
 * Body: { "secret": "<API_SECRET>", "name": "my-app", "expiresIn": "30d" }
 *
 * name      - label for this token (optional, default: "api-client")
 * expiresIn - token lifetime (optional, default: "90d") e.g. "7d", "1y", "365d"
 */
router.post('/api/auth/token', (req, res) => {
  if (!config.API_SECRET) {
    return res.status(500).json({ error: 'API_SECRET not configured' });
  }

  const { secret, name, expiresIn } = req.body || {};

  if (secret !== config.API_SECRET) {
    return res.status(403).json({ error: 'Invalid secret' });
  }

  const payload = { sub: name || 'api-client', iat: Math.floor(Date.now() / 1000) };
  const token = jwt.sign(payload, config.API_SECRET, { expiresIn: expiresIn || '90d' });

  return res.json({ token });
});

module.exports = router;
