// [xihanzu-NR]
'use strict';

const { openSqliteConnection } = require('./connection');
const { ensureSqliteMigrations } = require('./schema');
const {
  asString,
  asOptionalString,
  asOptionalNumber,
  asOptionalBytes,
  normalizeQueryLimit
} = require('./utils');

function decodeMessageRow(row) {
  return {
    id: asString(row.message_id, 'mailbox_messages.message_id'),
    threadJid: asString(row.thread_jid, 'mailbox_messages.thread_jid'),
    senderJid: asOptionalString(row.sender_jid),
    participantJid: asOptionalString(row.participant_jid),
    fromMe: Number(row.from_me) === 1,
    timestampMs: asOptionalNumber(row.timestamp_ms),
    messageBytes: asOptionalBytes(row.message_bytes)
  };
}

class WaMessageSqliteStore {
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
        await ensureSqliteMigrations(conn, ['mailbox'], this.logger);
        return conn;
      })();
    }
    return this._connPromise;
  }

  async upsert(record) {
    const db = await this.getConnection();
    this._upsertMessageRow(db, record);
  }

  async upsertBatch(records) {
    if (!records || records.length === 0) return;
    const db = await this.getConnection();
    await db.runInTransaction(() => {
      for (const record of records) {
        this._upsertMessageRow(db, record);
      }
    });
  }

  async getById(id) {
    const db = await this.getConnection();
    const row = db.get(
      `SELECT
        message_id,
        thread_jid,
        sender_jid,
        participant_jid,
        from_me,
        timestamp_ms,
        message_bytes
      FROM mailbox_messages
      WHERE session_id = ? AND message_id = ?`,
      [this.sessionId, id]
    );
    return row ? decodeMessageRow(row) : null;
  }

  async listByThread(threadJid, limit, beforeTimestampMs) {
    const db = await this.getConnection();
    const normalizedLimit = normalizeQueryLimit(limit, 50);

    const rows = beforeTimestampMs === undefined
      ? db.all(
          `SELECT
            message_id,
            thread_jid,
            sender_jid,
            participant_jid,
            from_me,
            timestamp_ms,
            message_bytes
          FROM mailbox_messages
          WHERE session_id = ? AND thread_jid = ?
          ORDER BY timestamp_ms DESC, message_id DESC
          LIMIT ?`,
          [this.sessionId, threadJid, normalizedLimit]
        )
      : db.all(
          `SELECT
            message_id,
            thread_jid,
            sender_jid,
            participant_jid,
            from_me,
            timestamp_ms,
            message_bytes
          FROM mailbox_messages
          WHERE session_id = ? AND thread_jid = ? AND timestamp_ms < ?
          ORDER BY timestamp_ms DESC, message_id DESC
          LIMIT ?`,
          [this.sessionId, threadJid, beforeTimestampMs, normalizedLimit]
        );

    return rows.map(decodeMessageRow);
  }

  async deleteById(id) {
    const db = await this.getConnection();
    db.run(
      `DELETE FROM mailbox_messages
       WHERE session_id = ? AND message_id = ?`,
      [this.sessionId, id]
    );
    const row = db.get('SELECT changes() AS total', []);
    return row ? Number(row.total) : 0;
  }

  async clear() {
    const db = await this.getConnection();
    db.run('DELETE FROM mailbox_messages WHERE session_id = ?', [this.sessionId]);
  }

  _upsertMessageRow(db, record) {
    const bytes = record.messageBytes ? Buffer.from(record.messageBytes) : null;
    db.run(
      `INSERT INTO mailbox_messages (
        session_id,
        message_id,
        thread_jid,
        sender_jid,
        participant_jid,
        from_me,
        timestamp_ms,
        message_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.sessionId,
        record.id,
        record.threadJid,
        record.senderJid || null,
        record.participantJid || null,
        record.fromMe ? 1 : 0,
        record.timestampMs || null,
        bytes
      ]
    );
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
  WaMessageSqliteStore
};
