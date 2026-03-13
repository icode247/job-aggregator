const { probeAtsApis } = require('../src/adapters/extractor');

const domain = process.argv[2] || 'anthropic.com';

(async () => {
  console.log(`Probing ATS APIs for domain: ${domain}\n`);
  const result = await probeAtsApis(domain);
  console.log('\nResult:', result);
})();
