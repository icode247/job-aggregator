const { Router } = require('express');
const { getAll } = require('../../utils/metrics');

const router = Router();

router.get('/api/metrics', async (req, res) => {
  const metrics = await getAll();
  res.json({ status: 'ok', ...metrics });
});

module.exports = router;
