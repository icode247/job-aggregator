const Database = require('better-sqlite3');
const config = require('../config');
const logger = require('../logger');

let db;

function getDb() {
  if (!db) {
    db = new Database(config.DATABASE_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    logger.info({ path: config.DATABASE_PATH }, 'SQLite database connected');
  }
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
    logger.info('SQLite database closed');
  }
}

module.exports = { getDb, closeDb };
