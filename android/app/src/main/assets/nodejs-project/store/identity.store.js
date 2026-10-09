// [xihanzu-NR]
'use strict';

const { openSqliteConnection } = require('./connection');
const { ensureSqliteMigrations } = require('./schema');
const { toSignalAddressParts } = require('./utils');

class WaIdentitySqliteStore {
  constructor(options = {}, storeOptions = {}) {
    this.options = options;
    this.sessionId = options.sessionId || 'default';
    this.logger = options.logger;
    this.identityBatchSize = storeOptions.identityBatchSize || 250;
    this._connPromise = null;
  }

  async getConnection() {
    if (!this._connPromise) {
      this._connPromise = (async () => {
        const conn = this.options.connection || (await openSqliteConnection(this.options, this.logger));
        await ensureSqliteMigrations(conn, ['signal'], this.logger);
        return conn;
      })();
    }
    return this._connPromise;
  }

  async getRemoteIdentity(address) {
    const db = await this.getConnection();
    const target = toSignalAddressParts(address);
    const row = db.get(
      `SELECT identity_key
       FROM signal_identity
       WHERE session_id = ? AND user = ? AND server = ? AND device = ?`,
      [this.sessionId, target.user, target.server, target.device]
    );
    if (!row || !row.identity_key) return null;
    return Buffer.isBuffer(row.identity_key) ? row.identity_key : Buffer.from(row.identity_key);
  }

  async getRemoteIdentities(addresses) {
    if (!addresses || addresses.length === 0) return [];
    const identities = new Array(addresses.length);
    for (let i = 0; i < addresses.length; i++) {
      identities[i] = await this.getRemoteIdentity(addresses[i]);
    }
    return identities;
  }

  async setRemoteIdentity(address, identityKey) {
    const db = await this.getConnection();
    const target = toSignalAddressParts(address);
    const keyBuf = Buffer.isBuffer(identityKey) ? identityKey : Buffer.from(identityKey);
    db.run(
      `INSERT INTO signal_identity (
        session_id,
        user,
        server,
        device,
        identity_key
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        this.sessionId,
        target.user,
        target.server,
        target.device,
        keyBuf
      ]
    );
  }

  async setRemoteIdentities(entries) {
    if (!entries || entries.length === 0) return;
    const db = await this.getConnection();
    await db.runInTransaction(() => {
      for (const entry of entries) {
        const target = toSignalAddressParts(entry.address);
        const keyBuf = Buffer.isBuffer(entry.identityKey) ? entry.identityKey : Buffer.from(entry.identityKey);
        db.run(
          `INSERT INTO signal_identity (
            session_id,
            user,
            server,
            device,
            identity_key
          ) VALUES (?, ?, ?, ?, ?)`,
          [
            this.sessionId,
            target.user,
            target.server,
            target.device,
            keyBuf
          ]
        );
      }
    });
  }

  async clear() {
    const db = await this.getConnection();
    await db.runInTransaction(() => {
      db.run('DELETE FROM signal_identity WHERE session_id = ?', [this.sessionId]);
    });
  }

  async destroy() {
    if (this._connPromise) {
      const conn = await this._connPromise;
      if (!this.options.connection) {
        conn.close();
      }
      this._connPromise = null;
    }
  }
}

module.exports = {
  WaIdentitySqliteStore
};
