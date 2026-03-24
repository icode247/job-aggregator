const { Router } = require('express');
const { companiesRepo } = require('../../db');

const router = Router();

router.post('/api/admin/companies', async (req, res) => {
  const { domains } = req.body;
  if (!Array.isArray(domains) || domains.length === 0) {
    return res.status(400).json({ error: 'Provide an array of domains' });
  }

  const added = [];
  for (const domain of domains) {
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    const company = await companiesRepo.create({
      careerUrl: `https://${cleanDomain}/careers`,
      domain: cleanDomain,
    });
    if (company) added.push({ id: company.id, domain: cleanDomain });
  }

  res.json({ added: added.length, companies: added });
});

module.exports = router;
