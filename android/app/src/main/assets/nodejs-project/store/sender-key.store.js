// [xihanzu-NR]
'use strict';

const { openSqliteConnection } = require('./connection');
const { ensureSqliteMigrations } = require('./schema');
const { toSignalAddressParts } = require('./utils');

class WaSenderKeySqliteStore {
  constructor(options = {}) {
    this.options = options;
    this.sessionId = options.sessionId || 'default';
    this.logger = options.logger;
    this._connPromise = null;
  }

  async getConnection() {
    if (!this._connPromise) {
      this._connPromise = (async () => {
        const conn = this.options.connection || (await openSqliteConnection(this.options, this.logger));
        await ensureSqliteMigrations(conn, ['senderKey'], this.logger);
        return conn;
      })();
    }
    return this._connPromise;
  }

  async upsertSenderKey(record) {
    const db = await this.getConnection();
    const sender = toSignalAddressParts(record.sender);
    const recBuf = Buffer.isBuffer(record.record) ? record.record : Buffer.from(record.record);
    db.run(
      `INSERT INTO sender_keys (
        session_id, group_id, sender_user, sender_server, sender_device, record
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        this.sessionId,
        record.groupId,
        sender.user,
        sender.server,
        sender.device,
        recBuf
      ]
    );
  }

  async upsertSenderKeyDistribution(record) {
    const db = await this.getConnection();
    const sender = toSignalAddressParts(record.sender);
    db.run(
      `INSERT INTO sender_key_distribution (
        session_id, group_id, sender_user, sender_server, sender_device, key_id, timestamp_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        this.sessionId,
        record.groupId,
        sender.user,
        sender.server,
        sender.device,
        record.keyId,
        record.timestampMs || Date.now()
      ]
    );
  }

  async getDeviceSenderKey(groupId, sender) {
    const db = await this.getConnection();
    const parts = toSignalAddressParts(sender);
    const row = db.get(
      `SELECT record FROM sender_keys
       WHERE session_id = ? AND group_id = ? AND sender_user = ? AND sender_server = ? AND sender_device = ?`,
      [this.sessionId, groupId, parts.user, parts.server, parts.device]
    );
    if (!row || !row.record) return null;
    return {
      groupId,
      sender: parts,
      record: Buffer.isBuffer(row.record) ? row.record : Buffer.from(row.record)
    };
  }

  async getGroupSenderKeyList(groupId) {
    const db = await this.getConnection();
    const skRows = db.all(
      `SELECT sender_user, sender_server, sender_device, record
       FROM sender_keys
       WHERE session_id = ? AND group_id = ?`,
      [this.sessionId, groupId]
    );
    const distribRows = db.all(
      `SELECT sender_user, sender_server, sender_device, key_id, timestamp_ms
       FROM sender_key_distribution
       WHERE session_id = ? AND group_id = ?`,
      [this.sessionId, groupId]
    );

    return {
      skList: skRows.map(r => ({
        groupId,
        sender: { user: r.sender_user, server: r.sender_server, device: r.sender_device },
        record: Buffer.isBuffer(r.record) ? r.record : Buffer.from(r.record)
      })),
      skDistribList: distribRows.map(r => ({
        groupId,
        sender: { user: r.sender_user, server: r.sender_server, device: r.sender_device },
        keyId: r.key_id,
        timestampMs: r.timestamp_ms
      }))
    };
  }

  async deleteDeviceSenderKey(target, groupId) {
    const db = await this.getConnection();
    const parts = toSignalAddressParts(target);
    if (groupId) {
      db.run(
        `DELETE FROM sender_keys
         WHERE session_id = ? AND group_id = ? AND sender_user = ? AND sender_server = ? AND sender_device = ?`,
        [this.sessionId, groupId, parts.user, parts.server, parts.device]
      );
    } else {
      db.run(
        `DELETE FROM sender_keys
         WHERE session_id = ? AND sender_user = ? AND sender_server = ? AND sender_device = ?`,
        [this.sessionId, parts.user, parts.server, parts.device]
      );
    }
    const row = db.get('SELECT changes() AS total', []);
    return row ? Number(row.total) : 0;
  }

  async clear() {
    const db = await this.getConnection();
    await db.runInTransaction(() => {
      db.run('DELETE FROM sender_keys WHERE session_id = ?', [this.sessionId]);
      db.run('DELETE FROM sender_key_distribution WHERE session_id = ?', [this.sessionId]);
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
  WaSenderKeySqliteStore
};
