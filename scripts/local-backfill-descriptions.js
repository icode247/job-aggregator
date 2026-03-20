#!/usr/bin/env node
/**
 * Run description backfill LOCALLY against production Postgres.
 *
 * Usage:
 *   DATABASE_URL=$(heroku config:get DATABASE_URL --app fastapply-board) node scripts/local-backfill-descriptions.js
 *
 * Or set DATABASE_URL in your .env and run:
 *   node scripts/local-backfill-descriptions.js
 *
 * This avoids Heroku's shared IP addresses which many ATS providers block.
 * Runs continuously with 2-minute intervals between cycles.
 */
require('dotenv').config();
const { backfillDescriptions } = require('../src/tasks/backfill-descriptions');
const logger = require('../src/logger');
const { migrate, closeDb } = require('../src/db');

const INTERVAL_MS = 2 * 60 * 1000; // 2 minutes between cycles

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL not set. Run with:');
    console.error('  DATABASE_URL=$(heroku config:get DATABASE_URL --app fastapply-board) node scripts/local-backfill-descriptions.js');
    process.exit(1);
  }

  await migrate();
  logger.info('Local description backfill started — connected to production DB');

  let cycle = 0;
  while (true) {
    cycle++;
    const start = Date.now();
    try {
      const filled = await backfillDescriptions();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      logger.info({ cycle, filled, elapsed: `${elapsed}s` }, 'Backfill cycle complete');
    } catch (err) {
      logger.error({ cycle, err: err.message }, 'Backfill cycle error');
    }
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
}

process.on('SIGINT', async () => {
  logger.info('Shutting down local backfill...');
  await closeDb();
  process.exit(0);
});

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
