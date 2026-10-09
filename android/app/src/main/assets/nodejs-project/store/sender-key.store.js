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
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, group_id, sender_user, sender_server, sender_device)
      DO UPDATE SET record = excluded.record`,
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, group_id, sender_user, sender_server, sender_device)
      DO UPDATE SET key_id = excluded.key_id, timestamp_ms = excluded.timestamp_ms`,
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

  async upsertSenderKeyDistributions(records) {
    if (!records || records.length === 0) return;
    const db = await this.getConnection();
    await db.runInTransaction(() => {
      for (const record of records) {
        const sender = toSignalAddressParts(record.sender);
        db.run(
          `INSERT INTO sender_key_distribution (
            session_id, group_id, sender_user, sender_server, sender_device, key_id, timestamp_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id, group_id, sender_user, sender_server, sender_device)
          DO UPDATE SET key_id = excluded.key_id, timestamp_ms = excluded.timestamp_ms`,
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
    });
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

  async getDeviceSenderKeyDistributions(groupId, senders) {
    if (!senders || senders.length === 0) return [];
    const db = await this.getConnection();
    const records = new Array(senders.length);
    for (let i = 0; i < senders.length; i++) {
      const parts = toSignalAddressParts(senders[i]);
      const row = db.get(
        `SELECT sender_user, sender_server, sender_device, key_id, timestamp_ms
         FROM sender_key_distribution
         WHERE session_id = ? AND group_id = ? AND sender_user = ? AND sender_server = ? AND sender_device = ?`,
        [this.sessionId, groupId, parts.user, parts.server, parts.device]
      );
      if (!row) {
        records[i] = null;
      } else {
        records[i] = {
          groupId,
          sender: { user: row.sender_user, server: row.sender_server, device: row.sender_device },
          keyId: row.key_id,
          timestampMs: row.timestamp_ms
        };
      }
    }
    return records;
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
    let total = 0;
    if (groupId) {
      db.run(
        `DELETE FROM sender_keys
         WHERE session_id = ? AND group_id = ? AND sender_user = ? AND sender_server = ? AND sender_device = ?`,
        [this.sessionId, groupId, parts.user, parts.server, parts.device]
      );
      const r1 = db.get('SELECT changes() AS total', []);
      total += r1 ? Number(r1.total) : 0;
      db.run(
        `DELETE FROM sender_key_distribution
         WHERE session_id = ? AND group_id = ? AND sender_user = ? AND sender_server = ? AND sender_device = ?`,
        [this.sessionId, groupId, parts.user, parts.server, parts.device]
      );
      const r2 = db.get('SELECT changes() AS total', []);
      total += r2 ? Number(r2.total) : 0;
    } else {
      db.run(
        `DELETE FROM sender_keys
         WHERE session_id = ? AND sender_user = ? AND sender_server = ? AND sender_device = ?`,
        [this.sessionId, parts.user, parts.server, parts.device]
      );
      const r1 = db.get('SELECT changes() AS total', []);
      total += r1 ? Number(r1.total) : 0;
      db.run(
        `DELETE FROM sender_key_distribution
         WHERE session_id = ? AND sender_user = ? AND sender_server = ? AND sender_device = ?`,
        [this.sessionId, parts.user, parts.server, parts.device]
      );
      const r2 = db.get('SELECT changes() AS total', []);
      total += r2 ? Number(r2.total) : 0;
    }
    return total;
  }

  async markForgetSenderKey(groupId, participants) {
    if (!participants || participants.length === 0) return 0;
    const db = await this.getConnection();
    let totalDeleted = 0;
    await db.runInTransaction(() => {
      for (const participant of participants) {
        const parts = toSignalAddressParts(participant);
        db.run(
          `DELETE FROM sender_keys
           WHERE session_id = ? AND group_id = ? AND sender_user = ? AND sender_server = ? AND sender_device = ?`,
          [this.sessionId, groupId, parts.user, parts.server, parts.device]
        );
        const r1 = db.get('SELECT changes() AS total', []);
        totalDeleted += r1 ? Number(r1.total) : 0;

        db.run(
          `DELETE FROM sender_key_distribution
           WHERE session_id = ? AND group_id = ? AND sender_user = ? AND sender_server = ? AND sender_device = ?`,
          [this.sessionId, groupId, parts.user, parts.server, parts.device]
        );
        const r2 = db.get('SELECT changes() AS total', []);
        totalDeleted += r2 ? Number(r2.total) : 0;
      }
    });
    return totalDeleted;
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
