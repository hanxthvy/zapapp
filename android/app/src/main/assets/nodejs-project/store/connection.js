// [xihanzu-NR]
'use strict';

const path = require('path');
const { PureJsSqliteEngine } = require('./pure-js-engine');
const { resolveFilesDir, getSessionDbPath } = require('./utils');

const SQLITE_CONNECTION_CACHE = new Map();

// [xihanzu-NR] Default PRAGMAs; options.pragmas overrides any of these per connection.
const DEFAULT_PRAGMAS = {
  journal_mode: 'WAL',
  synchronous: 'NORMAL',
  foreign_keys: 'ON',
  busy_timeout: 5000
};

/**
 * Merges caller-supplied pragmas over the defaults and rejects unsafe names/values
 * (pragma keys/values are interpolated into SQL text).
 */
function resolvePragmas(overrides) {
  const merged = { ...DEFAULT_PRAGMAS };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!/^[a-zA-Z_]+$/.test(key)) continue;
    if (!/^[a-zA-Z0-9_]+$/.test(String(value))) continue;
    merged[key] = value;
  }
  return merged;
}

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
  // [xihanzu-NR] 'sqlite3' is never auto-selected: its get/all API is callback-async and
  // cannot satisfy the synchronous WaSqliteConnection contract (wrapConnection.get()
  // would return the Database instance instead of query result rows).
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
 * Opens SQLite connection applying resolved PRAGMAs (WAL mode by default).
 */
async function openSqliteConnection(options = {}, logger) {
  const dbPath = options.path || getSessionDbPath(options.filesDir);
  const driver = resolveDriver(options.driver);
  const pragmas = resolvePragmas(options.pragmas);

  const cacheKey = `${driver}|${dbPath}|${JSON.stringify(pragmas)}`;
  if (SQLITE_CONNECTION_CACHE.has(cacheKey)) {
    const cached = SQLITE_CONNECTION_CACHE.get(cacheKey);
    cached.refs++;
    return createConnectionHandle(cached, cacheKey);
  }

  const pragmaStatements = Object.entries(pragmas).map(([key, value]) => `PRAGMA ${key} = ${value};`);

  let rawDb;
  if (driver === 'better-sqlite3') {
    const BetterSqlite3 = require('better-sqlite3');
    rawDb = new BetterSqlite3(dbPath);
    for (const [key, value] of Object.entries(pragmas)) {
      rawDb.pragma(`${key} = ${value}`);
    }
  } else if (driver === 'node') {
    const { DatabaseSync } = require('node:sqlite');
    rawDb = new DatabaseSync(dbPath);
    for (const statement of pragmaStatements) {
      rawDb.exec(statement);
    }
  } else if (driver === 'sqlite3') {
    // [xihanzu-NR] sqlite3 uses async callbacks and cannot satisfy the synchronous
    // WaSqliteConnection contract (wrapConnection.get/all would return the Database
    // instance instead of query result rows). Use 'better-sqlite3', 'node', or 'pure-js'.
    throw new Error(
      "The 'sqlite3' driver uses asynchronous callbacks and cannot satisfy the synchronous WaSqliteConnection contract. Use 'better-sqlite3', 'node' (DatabaseSync), or 'pure-js'."
    );
  } else {
    // Pure JS SQLite Engine with resolved pragma settings
    rawDb = new PureJsSqliteEngine(dbPath, {
      journalMode: String(pragmas.journal_mode || 'wal').toLowerCase(),
      synchronous: String(pragmas.synchronous || 'normal').toLowerCase(),
      busyTimeout: parseInt(pragmas.busy_timeout, 10) || 5000
    });
    for (const statement of pragmaStatements) {
      rawDb.exec(statement);
    }
  }

  const conn = wrapConnection(rawDb, driver);
  const entry = {
    connection: conn,
    refs: 1
  };
  SQLITE_CONNECTION_CACHE.set(cacheKey, entry);

  if (logger && typeof logger.info === 'function') {
    logger.info('SQLite storage connection established', { path: dbPath, driver, journalMode: pragmas.journal_mode });
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
