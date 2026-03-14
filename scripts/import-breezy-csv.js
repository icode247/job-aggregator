/**
 * Import Breezy companies from CSV and queue them for sync.
 * Usage: node scripts/import-breezy-csv.js /path/to/breezy_hr_companies.csv
 */
const fs = require('fs');
const { migrate, companiesRepo } = require('../src/db');
const { createSyncQueue } = require('../src/queues/sync.queue');
const logger = require('../src/logger');

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: node scripts/import-breezy-csv.js <csv-file>');
    process.exit(1);
  }

  await migrate();
  const syncQueue = createSyncQueue();

  const csv = fs.readFileSync(csvPath, 'utf-8');
  const lines = csv.split('\n').slice(1).filter(l => l.trim());

  let imported = 0;
  let skipped = 0;

  for (const line of lines) {
    // Parse CSV: "Company Name","subdomain","Job Title","Industry"
    const match = line.match(/"([^"]*)","([^"]*)","([^"]*)","([^"]*)"/);
    if (!match) continue;

    const [, companyName, slug] = match;
    if (!slug) continue;

    // Check if already exists
    const existing = await companiesRepo.findByAtsAndSlug('breezy', slug);
    if (existing) {
      skipped++;
      continue;
    }

    // Create company
    const company = await companiesRepo.createFromCrawl({
      ats: 'breezy',
      atsSlug: slug,
      origin: 'csv-import',
    });

    if (company) {
      // Queue for immediate sync
      await syncQueue.add(`sync-${company.id}`, {
        companyId: company.id,
        ats: 'breezy',
        atsSlug: slug,
      });
      imported++;
    }
  }

  console.log(`Done: ${imported} imported, ${skipped} already existed`);
  await syncQueue.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
