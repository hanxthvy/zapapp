// [xihanzu-NR]
'use strict';

const { openSqliteConnection } = require('./connection');
const { ensureSqliteMigrations } = require('./schema');
const {
  toSignalAddressParts,
  signalAddressKey,
  asString,
  asNumber
} = require('./utils');

class WaSessionSqliteStore {
  constructor(options = {}, storeOptions = {}) {
    this.options = options;
    this.sessionId = options.sessionId || 'default';
    this.logger = options.logger;
    this.hasSessionBatchSize = storeOptions.hasSessionBatchSize || 250;
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

  async hasSession(address) {
    const db = await this.getConnection();
    const target = toSignalAddressParts(address);
    const row = db.get(
      `SELECT 1 AS has_session
       FROM signal_session
       WHERE session_id = ? AND user = ? AND server = ? AND device = ?
       LIMIT 1`,
      [this.sessionId, target.user, target.server, target.device]
    );
    return row !== null;
  }

  async hasSessions(addresses) {
    if (!addresses || addresses.length === 0) {
      return [];
    }
    const results = new Array(addresses.length);
    for (let i = 0; i < addresses.length; i++) {
      results[i] = await this.hasSession(addresses[i]);
    }
    return results;
  }

  async getSession(address) {
    const db = await this.getConnection();
    const target = toSignalAddressParts(address);
    const row = db.get(
      `SELECT user, server, device, record
       FROM signal_session
       WHERE session_id = ? AND user = ? AND server = ? AND device = ?`,
      [this.sessionId, target.user, target.server, target.device]
    );
    if (!row || !row.record) return null;
    return Buffer.isBuffer(row.record) ? row.record : Buffer.from(row.record);
  }

  async getSessionsBatch(addresses) {
    if (!addresses || addresses.length === 0) {
      return [];
    }
    const sessions = new Array(addresses.length);
    for (let i = 0; i < addresses.length; i++) {
      sessions[i] = await this.getSession(addresses[i]);
    }
    return sessions;
  }

  async setSession(address, session) {
    const db = await this.getConnection();
    const target = toSignalAddressParts(address);
    const recordBuf = Buffer.isBuffer(session) ? session : Buffer.from(session);

    db.run(
      `INSERT INTO signal_session (
        session_id,
        user,
        server,
        device,
        record
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, user, server, device)
      DO UPDATE SET record = excluded.record`,
      [
        this.sessionId,
        target.user,
        target.server,
        target.device,
        recordBuf
      ]
    );
  }

  async setSessionsBatch(entries) {
    if (!entries || entries.length === 0) return;
    const db = await this.getConnection();
    await db.runInTransaction(() => {
      for (const entry of entries) {
        const target = toSignalAddressParts(entry.address);
        const recordBuf = Buffer.isBuffer(entry.session) ? entry.session : Buffer.from(entry.session);
        db.run(
          `INSERT INTO signal_session (
            session_id,
            user,
            server,
            device,
            record
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(session_id, user, server, device)
          DO UPDATE SET record = excluded.record`,
          [
            this.sessionId,
            target.user,
            target.server,
            target.device,
            recordBuf
          ]
        );
      }
    });
  }

  async deleteSession(address) {
    const db = await this.getConnection();
    const target = toSignalAddressParts(address);
    db.run(
      `DELETE FROM signal_session
       WHERE session_id = ? AND user = ? AND server = ? AND device = ?`,
      [this.sessionId, target.user, target.server, target.device]
    );
  }

  async clear() {
    const db = await this.getConnection();
    await db.runInTransaction(() => {
      db.run('DELETE FROM signal_session WHERE session_id = ?', [this.sessionId]);
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
  WaSessionSqliteStore
};
