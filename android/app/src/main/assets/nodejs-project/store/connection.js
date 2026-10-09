// [xihanzu-NR]
'use strict';

const path = require('path');
const { PureJsSqliteEngine } = require('./pure-js-engine');
const { resolveFilesDir, getSessionDbPath } = require('./utils');

const SQLITE_CONNECTION_CACHE = new Map();

/**
 * Checks if a Node module can be required without throwing error.
 */
function canRequireModule(name) {
  try {
    require(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the appropriate SQLite driver.
 */
function resolveDriver(requested) {
  if (requested && requested !== 'auto') {
    return requested;
  }
  if (canRequireModule('better-sqlite3')) {
    return 'better-sqlite3';
  }
  if (canRequireModule('node:sqlite')) {
    return 'node';
  }
  if (canRequireModule('sqlite3')) {
    return 'sqlite3';
  }
  return 'pure-js';
}

/**
 * Wraps a driver database instance in the standardized WaSqliteConnection contract.
 */
function wrapConnection(db, driver) {
  let closed = false;

  const ensureOpen = () => {
    if (closed) throw new Error('sqlite connection is closed');
  };

  return {
    driver,
    exec(sql) {
      ensureOpen();
      db.exec(sql);
    },
    run(sql, params) {
      ensureOpen();
      if (!params || params.length === 0) {
        db.run ? db.run(sql) : db.prepare(sql).run();
      } else {
        db.run ? db.run(sql, params) : db.prepare(sql).run(...params);
      }
    },
    get(sql, params) {
      ensureOpen();
      if (db.get) {
        return db.get(sql, params) || null;
      }
      const stmt = db.prepare(sql);
      const row = !params || params.length === 0 ? stmt.get() : stmt.get(...params);
      return row || null;
    },
    all(sql, params) {
      ensureOpen();
      if (db.all) {
        return db.all(sql, params) || [];
      }
      const stmt = db.prepare(sql);
      const rows = !params || params.length === 0 ? stmt.all() : stmt.all(...params);
      return Array.isArray(rows) ? rows : [];
    },
    runInTransaction(task) {
      ensureOpen();
      if (db.runInTransaction) {
        return db.runInTransaction(task);
      }
      if (typeof db.transaction === 'function') {
        const tx = db.transaction(task);
        return Promise.resolve(tx());
      }
      db.exec('BEGIN');
      try {
        const res = task();
        db.exec('COMMIT');
        return Promise.resolve(res);
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        return Promise.reject(err);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (typeof db.close === 'function') {
        db.close();
      }
    }
  };
}

/**
 * Opens SQLite connection and enforces WAL mode.
 */
async function openSqliteConnection(options = {}, logger) {
  const dbPath = options.path || getSessionDbPath(options.filesDir);
  const driver = resolveDriver(options.driver);

  const cacheKey = `${driver}|${dbPath}`;
  if (SQLITE_CONNECTION_CACHE.has(cacheKey)) {
    const cached = SQLITE_CONNECTION_CACHE.get(cacheKey);
    cached.refs++;
    return createConnectionHandle(cached, cacheKey);
  }

  let rawDb;
  if (driver === 'better-sqlite3') {
    const BetterSqlite3 = require('better-sqlite3');
    rawDb = new BetterSqlite3(dbPath);
    rawDb.pragma('journal_mode = WAL');
    rawDb.pragma('synchronous = NORMAL');
    rawDb.pragma('foreign_keys = ON');
    rawDb.pragma('busy_timeout = 5000');
  } else if (driver === 'node') {
    const { DatabaseSync } = require('node:sqlite');
    rawDb = new DatabaseSync(dbPath);
    rawDb.exec('PRAGMA journal_mode = WAL;');
    rawDb.exec('PRAGMA synchronous = NORMAL;');
    rawDb.exec('PRAGMA foreign_keys = ON;');
    rawDb.exec('PRAGMA busy_timeout = 5000;');
  } else if (driver === 'sqlite3') {
    const sqlite3 = require('sqlite3').verbose();
    const sdb = new sqlite3.Database(dbPath);
    await new Promise((resolve, reject) => {
      sdb.serialize(() => {
        sdb.run('PRAGMA journal_mode = WAL;');
        sdb.run('PRAGMA synchronous = NORMAL;');
        sdb.run('PRAGMA foreign_keys = ON;');
        sdb.run('PRAGMA busy_timeout = 5000;', (err) => {
          if (err) reject(err); else resolve();
        });
      });
    });
    // Wrap callback-based sqlite3 to sync-like API using synchronous queries or in-memory snapshot
    rawDb = sdb;
  } else {
    // Pure JS SQLite Engine with WAL mode
    rawDb = new PureJsSqliteEngine(dbPath, {
      journalMode: 'wal',
      synchronous: 'normal',
      busyTimeout: 5000
    });
    rawDb.exec('PRAGMA journal_mode = WAL;');
    rawDb.exec('PRAGMA synchronous = NORMAL;');
    rawDb.exec('PRAGMA foreign_keys = ON;');
    rawDb.exec('PRAGMA busy_timeout = 5000;');
  }

  const conn = wrapConnection(rawDb, driver);
  const entry = {
    connection: conn,
    refs: 1
  };
  SQLITE_CONNECTION_CACHE.set(cacheKey, entry);

  if (logger && typeof logger.info === 'function') {
    logger.info('SQLite storage connection established', { path: dbPath, driver, journalMode: 'WAL' });
  }

  return createConnectionHandle(entry, cacheKey);
}

function createConnectionHandle(entry, cacheKey) {
  let closed = false;
  return {
    get driver() { return entry.connection.driver; },
    exec(sql) {
      if (closed) throw new Error('Handle closed');
      entry.connection.exec(sql);
    },
    run(sql, params) {
      if (closed) throw new Error('Handle closed');
      entry.connection.run(sql, params);
    },
    get(sql, params) {
      if (closed) throw new Error('Handle closed');
      return entry.connection.get(sql, params);
    },
    all(sql, params) {
      if (closed) throw new Error('Handle closed');
      return entry.connection.all(sql, params);
    },
    runInTransaction(task) {
      if (closed) throw new Error('Handle closed');
      return entry.connection.runInTransaction(task);
    },
    close() {
      if (closed) return;
      closed = true;
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs === 0) {
        SQLITE_CONNECTION_CACHE.delete(cacheKey);
        entry.connection.close();
      }
    }
  };
}

module.exports = {
  openSqliteConnection,
  resolveDriver
};
