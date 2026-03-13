const { Router } = require('express');
const jwt = require('jsonwebtoken');
const config = require('../../config');

const router = Router();

/**
 * POST /api/auth/token
 *
 * Generate an API token using the master secret.
 * Header: Authorization: Bearer <API_SECRET>
 * Body:   { "name": "my-app", "expiresIn": "30d" }
 *
 * name      - label for this token (optional, default: "api-client")
 * expiresIn - token lifetime (optional, default: "90d") e.g. "7d", "1y", "365d"
 */
router.post('/api/auth/token', (req, res) => {
  if (!config.API_SECRET) {
    return res.status(500).json({ error: 'API_SECRET not configured' });
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  const secret = header.slice(7);
  if (secret !== config.API_SECRET) {
    return res.status(403).json({ error: 'Invalid secret' });
  }

  const { name, expiresIn } = req.body || {};
  const payload = { sub: name || 'api-client', iat: Math.floor(Date.now() / 1000) };
  const opts = {};
  if (expiresIn && expiresIn !== 'never') opts.expiresIn = expiresIn;
  else if (!expiresIn) opts.expiresIn = '90d';
  const token = jwt.sign(payload, config.API_SECRET, opts);

  return res.json({ token });
});

module.exports = router;
