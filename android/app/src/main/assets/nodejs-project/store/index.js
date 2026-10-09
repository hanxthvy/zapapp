// [xihanzu-NR]
'use strict';

const { resolveFilesDir, getSessionDbPath, getWalDbPath } = require('./utils');
const { openSqliteConnection, resolveDriver } = require('./connection');
const { PureJsSqliteEngine } = require('./pure-js-engine');
const { SCHEMA_MIGRATIONS, ensureSqliteMigrations } = require('./schema');
const { WaAuthSqliteStore } = require('./auth.store');
const { WaSessionSqliteStore } = require('./session.store');
const { WaIdentitySqliteStore } = require('./identity.store');
const { WaMessageSqliteStore } = require('./message.store');
const { WaSignalSqliteStore } = require('./signal.store');
const { WaSenderKeySqliteStore } = require('./sender-key.store');

/**
 * Creates a zapo-compatible SQLite store backend provider.
 * Mirrors @zapo-js/store-sqlite createSqliteStore.
 */
function createSqliteStore(config = {}) {
  const filesDir = resolveFilesDir(config.filesDir);
  const dbPath = config.path || getSessionDbPath(filesDir);
  const driver = config.driver || 'auto';
  const connection = config.connection;
  const logger = config.logger;

  const makeOpts = (sessionId, domain) => ({
    sessionId: sessionId || 'default',
    path: connection ? undefined : dbPath,
    filesDir,
    connection,
    driver,
    logger,
    pragmas: {
      journal_mode: 'WAL',
      synchronous: 'NORMAL',
      foreign_keys: 'ON',
      busy_timeout: 5000,
      ...(config.pragmas || {})
    }
  });

  return {
    stores: {
      auth: (sessionId) => new WaAuthSqliteStore(makeOpts(sessionId, 'auth')),
      session: (sessionId) => new WaSessionSqliteStore(makeOpts(sessionId, 'session')),
      identity: (sessionId) => new WaIdentitySqliteStore(makeOpts(sessionId, 'identity')),
      messages: (sessionId) => new WaMessageSqliteStore(makeOpts(sessionId, 'messages')),
      signal: (sessionId) => new WaSignalSqliteStore(makeOpts(sessionId, 'signal')),
      preKey: (sessionId) => new WaSignalSqliteStore(makeOpts(sessionId, 'preKey')),
      senderKey: (sessionId) => new WaSenderKeySqliteStore(makeOpts(sessionId, 'senderKey'))
    },
    caches: {}
  };
}

/**
 * Higher-level initialization for zapo persistence in Android nodejs-project.
 * Automatically resolves filesDir + '/session.sqlite', ensures WAL mode,
 * and provides full access to sessions, auth keys, Signal identities, and messages.
 */
async function createPersistenceStore(options = {}) {
  const filesDir = resolveFilesDir(options.filesDir);
  const dbPath = getSessionDbPath(filesDir);
  const walPath = getWalDbPath(filesDir);
  const sessionId = options.sessionId || 'default';
  const logger = options.logger;

  const connection = await openSqliteConnection({
    path: dbPath,
    filesDir,
    driver: options.driver || 'auto',
    logger
  }, logger);

  // Run all migrations up front
  await ensureSqliteMigrations(connection, ['auth', 'signal', 'senderKey', 'mailbox'], logger);

  const authStore = new WaAuthSqliteStore({ sessionId, connection, logger });
  const sessionStore = new WaSessionSqliteStore({ sessionId, connection, logger });
  const identityStore = new WaIdentitySqliteStore({ sessionId, connection, logger });
  const messageStore = new WaMessageSqliteStore({ sessionId, connection, logger });
  const signalStore = new WaSignalSqliteStore({ sessionId, connection, logger });
  const senderKeyStore = new WaSenderKeySqliteStore({ sessionId, connection, logger });

  return {
    dbPath,
    walPath,
    filesDir,
    sessionId,
    connection,
    auth: authStore,
    session: sessionStore,
    identity: identityStore,
    messages: messageStore,
    signal: signalStore,
    senderKey: senderKeyStore,
    backend: createSqliteStore({ connection, filesDir, logger }),
    close: async () => {
      connection.close();
    }
  };
}

module.exports = {
  createSqliteStore,
  createPersistenceStore,
  resolveFilesDir,
  getSessionDbPath,
  getWalDbPath,
  openSqliteConnection,
  resolveDriver,
  PureJsSqliteEngine,
  WaAuthSqliteStore,
  WaSessionSqliteStore,
  WaIdentitySqliteStore,
  WaMessageSqliteStore,
  WaSignalSqliteStore,
  WaSenderKeySqliteStore,
  SCHEMA_MIGRATIONS,
  ensureSqliteMigrations
};
