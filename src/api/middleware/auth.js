const jwt = require('jsonwebtoken');
const config = require('../../config');

function authMiddleware(req, res, next) {
  if (!config.API_SECRET) return next();

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = header.slice(7);
  try {
    req.tokenPayload = jwt.verify(token, config.API_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = authMiddleware;
