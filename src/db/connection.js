const config = require('../config');
const logger = require('../logger');

const isPostgres = !!process.env.DATABASE_URL;

let db; // SQLite instance
let pool; // PG pool

function getDb() {
  if (isPostgres) {
    if (!pool) {
      const { Pool } = require('pg');
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: config.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        max: 15,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 10000,
      });
      logger.info('PostgreSQL pool connected');
    }
    return pool;
  }

  if (!db) {
    const Database = require('better-sqlite3');
    db = new Database(config.DATABASE_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    logger.info({ path: config.DATABASE_PATH }, 'SQLite database connected');
  }
  return db;
}

async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('PostgreSQL pool closed');
  }
  if (db) {
    db.close();
    db = null;
    logger.info('SQLite database closed');
  }
}

/**
 * Unified query helper. Works with both SQLite and PostgreSQL.
 * - sql: SQL string with ? placeholders (auto-converted to $1,$2... for PG)
 * - params: array of parameters
 * Returns: { rows, rowCount, lastId }
 */
async function query(sql, params = []) {
  if (isPostgres) {
    // Convert ? placeholders to $1, $2, etc.
    let idx = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
    // Convert datetime('now') to NOW()
    const finalSql = pgSql
      .replace(/datetime\('now'\)/gi, 'NOW()')
      .replace(/INSERT OR IGNORE/gi, 'INSERT')
      .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY');

    const result = await getDb().query(finalSql, params);
    return {
      rows: result.rows,
      rowCount: result.rowCount,
      lastId: result.rows?.[0]?.id || null,
    };
  }

  // SQLite — convert ILIKE to LIKE (SQLite LIKE is case-insensitive for ASCII)
  const sqliteSql = sql.replace(/ILIKE/gi, 'LIKE');
  const database = getDb();
  const isSelect = sqliteSql.trimStart().toUpperCase().startsWith('SELECT');
  const isInsert = sqliteSql.trimStart().toUpperCase().startsWith('INSERT');

  if (isSelect) {
    const rows = database.prepare(sqliteSql).all(...params);
    return { rows, rowCount: rows.length, lastId: null };
  }

  const result = database.prepare(sqliteSql).run(...params);
  return {
    rows: [],
    rowCount: result.changes,
    lastId: isInsert ? result.lastInsertRowid : null,
  };
}

/**
 * Run multiple statements (for schema creation). Only for DDL.
 */
async function exec(sql) {
  if (isPostgres) {
    const pgSql = sql
      .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY')
      .replace(/datetime\('now'\)/gi, 'NOW()')
      .replace(/INSERT OR IGNORE/gi, 'INSERT');
    await getDb().query(pgSql);
  } else {
    getDb().exec(sql);
  }
}

/**
 * Run a function inside a transaction.
 */
async function transaction(fn) {
  if (isPostgres) {
    const client = await getDb().connect();
    try {
      await client.query('BEGIN');
      const result = await fn({
        async query(sql, params = []) {
          let idx = 0;
          const pgSql = sql
            .replace(/\?/g, () => `$${++idx}`)
            .replace(/datetime\('now'\)/gi, 'NOW()')
            .replace(/INSERT OR IGNORE/gi, 'INSERT');
          return client.query(pgSql, params);
        },
      });
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // SQLite transactions are synchronous
  const database = getDb();
  return database.transaction(() => fn({
    query(sql, params = []) {
      const isSelect = sql.trimStart().toUpperCase().startsWith('SELECT');
      if (isSelect) {
        return { rows: database.prepare(sql).all(...params) };
      }
      const result = database.prepare(sql).run(...params);
      return { rows: [], rowCount: result.changes };
    },
  }))();
}

module.exports = { getDb, closeDb, query, exec, transaction, isPostgres };
