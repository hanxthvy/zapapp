// [xihanzu-NR]
'use strict';

const { openSqliteConnection } = require('./connection');
const { ensureSqliteMigrations } = require('./schema');
const { asBytes, asNumber, asOptionalBytes, asOptionalNumber } = require('./utils');

class WaSignalSqliteStore {
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
        await ensureSqliteMigrations(conn, ['signal'], this.logger);
        return conn;
      })();
    }
    return this._connPromise;
  }

  async getRegistrationInfo() {
    const db = await this.getConnection();
    const row = db.get(
      `SELECT registration_id, identity_pub_key, identity_priv_key
       FROM signal_registration
       WHERE session_id = ?`,
      [this.sessionId]
    );
    if (!row) return null;
    return {
      registrationId: asNumber(row.registration_id, 'registration_id'),
      identityKeyPair: {
        pubKey: asBytes(row.identity_pub_key, 'identity_pub_key'),
        privKey: asBytes(row.identity_priv_key, 'identity_priv_key')
      }
    };
  }

  async setRegistrationInfo(info) {
    const db = await this.getConnection();
    db.run(
      `INSERT INTO signal_registration (
        session_id, registration_id, identity_pub_key, identity_priv_key
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        registration_id=excluded.registration_id,
        identity_pub_key=excluded.identity_pub_key,
        identity_priv_key=excluded.identity_priv_key`,
      [
        this.sessionId,
        info.registrationId,
        Buffer.from(info.identityKeyPair.pubKey),
        Buffer.from(info.identityKeyPair.privKey)
      ]
    );
  }

  async getSignedPreKey() {
    const db = await this.getConnection();
    const row = db.get(
      `SELECT key_id, pub_key, priv_key, signature, uploaded
       FROM signal_signed_prekey
       WHERE session_id = ?`,
      [this.sessionId]
    );
    if (!row) return null;
    return {
      keyId: asNumber(row.key_id, 'key_id'),
      keyPair: {
        pubKey: asBytes(row.pub_key, 'pub_key'),
        privKey: asBytes(row.priv_key, 'priv_key')
      },
      signature: asBytes(row.signature, 'signature'),
      uploaded: Number(row.uploaded) === 1
    };
  }

  async setSignedPreKey(record) {
    const db = await this.getConnection();
    db.run(
      `INSERT INTO signal_signed_prekey (
        session_id, key_id, pub_key, priv_key, signature, uploaded
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        key_id=excluded.key_id,
        pub_key=excluded.pub_key,
        priv_key=excluded.priv_key,
        signature=excluded.signature,
        uploaded=excluded.uploaded`,
      [
        this.sessionId,
        record.keyId,
        Buffer.from(record.keyPair.pubKey),
        Buffer.from(record.keyPair.privKey),
        Buffer.from(record.signature),
        record.uploaded ? 1 : 0
      ]
    );
  }

  async getSignedPreKeyById(keyId) {
    const current = await this.getSignedPreKey();
    return current && current.keyId === keyId ? current : null;
  }

  async setSignedPreKeyRotationTs(value) {
    const db = await this.getConnection();
    db.run(
      `INSERT INTO signal_meta (session_id, signed_prekey_rotation_ts)
       VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET signed_prekey_rotation_ts = excluded.signed_prekey_rotation_ts`,
      [this.sessionId, value]
    );
  }

  async getSignedPreKeyRotationTs() {
    const db = await this.getConnection();
    const row = db.get(
      `SELECT signed_prekey_rotation_ts
       FROM signal_meta
       WHERE session_id = ?`,
      [this.sessionId]
    );
    return row ? asOptionalNumber(row.signed_prekey_rotation_ts) : null;
  }

  // Pre-Key APIs
  _decodePreKeyRow(row) {
    if (!row) return null;
    return {
      keyId: asNumber(row.key_id, 'key_id'),
      keyPair: {
        pubKey: asBytes(row.pub_key, 'pub_key'),
        privKey: asBytes(row.priv_key, 'priv_key')
      },
      uploaded: Number(row.uploaded) === 1
    };
  }

  async putPreKey(record) {
    const db = await this.getConnection();
    db.run(
      `INSERT INTO signal_prekey (
        session_id, key_id, pub_key, priv_key, uploaded
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, key_id) DO UPDATE SET
        pub_key = excluded.pub_key,
        priv_key = excluded.priv_key,
        uploaded = excluded.uploaded`,
      [
        this.sessionId,
        record.keyId,
        Buffer.from(record.keyPair.pubKey),
        Buffer.from(record.keyPair.privKey),
        record.uploaded ? 1 : 0
      ]
    );

    const metaRow = db.get(
      `SELECT next_prekey_id FROM signal_meta WHERE session_id = ?`,
      [this.sessionId]
    );
    const currentNext = metaRow && metaRow.next_prekey_id != null ? Number(metaRow.next_prekey_id) : 1;
    if (record.keyId >= currentNext) {
      db.run(
        `INSERT INTO signal_meta (session_id, next_prekey_id)
         VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET next_prekey_id = excluded.next_prekey_id`,
        [this.sessionId, record.keyId + 1]
      );
    }
  }

  async getOrGenPreKeys(count, generator) {
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error(`invalid prekey count: ${count}`);
    }
    const db = await this.getConnection();
    const rows = db.all(
      `SELECT key_id, pub_key, priv_key, uploaded
       FROM signal_prekey
       WHERE session_id = ? AND uploaded = ?
       ORDER BY key_id ASC`,
      [this.sessionId, 0]
    );

    const available = [];
    for (let i = 0; i < rows.length; i++) {
      const decoded = this._decodePreKeyRow(rows[i]);
      if (decoded) {
        available.push(decoded);
        if (available.length >= count) {
          return available;
        }
      }
    }

    let nextKeyId = 1;
    const metaRow = db.get(
      `SELECT next_prekey_id FROM signal_meta WHERE session_id = ?`,
      [this.sessionId]
    );
    if (metaRow && metaRow.next_prekey_id != null) {
      nextKeyId = Math.max(1, asNumber(metaRow.next_prekey_id, 'next_prekey_id'));
    } else {
      const maxRows = db.all(
        `SELECT key_id FROM signal_prekey WHERE session_id = ? ORDER BY key_id DESC LIMIT 1`,
        [this.sessionId]
      );
      if (maxRows && maxRows.length > 0 && maxRows[0].key_id != null) {
        nextKeyId = Math.max(1, asNumber(maxRows[0].key_id, 'key_id') + 1);
      }
    }

    while (available.length < count) {
      const currentId = nextKeyId++;
      const record = await generator(currentId);
      await this.putPreKey(record);
      available.push(record);
    }

    db.run(
      `INSERT INTO signal_meta (session_id, next_prekey_id)
       VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET next_prekey_id = excluded.next_prekey_id`,
      [this.sessionId, nextKeyId]
    );

    return available;
  }

  async getPreKeyById(keyId) {
    const db = await this.getConnection();
    const row = db.get(
      `SELECT key_id, pub_key, priv_key, uploaded
       FROM signal_prekey
       WHERE session_id = ? AND key_id = ?`,
      [this.sessionId, keyId]
    );
    return this._decodePreKeyRow(row);
  }

  async getPreKeysById(keyIds) {
    if (!Array.isArray(keyIds) || keyIds.length === 0) return [];
    const db = await this.getConnection();
    const results = new Array(keyIds.length);

    if (keyIds.length <= 10) {
      for (let i = 0; i < keyIds.length; i++) {
        results[i] = await this.getPreKeyById(keyIds[i]);
      }
      return results;
    }

    const rows = db.all(
      `SELECT key_id, pub_key, priv_key, uploaded
       FROM signal_prekey
       WHERE session_id = ?`,
      [this.sessionId]
    );
    const map = new Map();
    for (let i = 0; i < rows.length; i++) {
      const decoded = this._decodePreKeyRow(rows[i]);
      if (decoded) {
        map.set(decoded.keyId, decoded);
      }
    }

    for (let i = 0; i < keyIds.length; i++) {
      results[i] = map.get(Number(keyIds[i])) || null;
    }
    return results;
  }

  async consumePreKeyById(keyId) {
    const record = await this.getPreKeyById(keyId);
    if (!record) return null;
    const db = await this.getConnection();
    db.run('DELETE FROM signal_prekey WHERE session_id = ? AND key_id = ?', [this.sessionId, keyId]);
    return record;
  }

  async getOrGenSinglePreKey(generator) {
    const preKeys = await this.getOrGenPreKeys(1, generator);
    return preKeys[0];
  }

  async markKeyAsUploaded(keyId) {
    const id = Number(keyId);
    const db = await this.getConnection();
    db.run(
      'UPDATE signal_prekey SET uploaded = ? WHERE session_id = ? AND key_id <= ?',
      [1, this.sessionId, id]
    );
  }

  async setServerHasPreKeys(value) {
    const db = await this.getConnection();
    db.run(
      `INSERT INTO signal_meta (session_id, server_has_prekeys)
       VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET server_has_prekeys = excluded.server_has_prekeys`,
      [this.sessionId, value ? 1 : 0]
    );
  }

  async getServerHasPreKeys() {
    const db = await this.getConnection();
    const row = db.get('SELECT server_has_prekeys FROM signal_meta WHERE session_id = ?', [this.sessionId]);
    return row ? Number(row.server_has_prekeys) === 1 : false;
  }

  async clear() {
    const db = await this.getConnection();
    await db.runInTransaction(() => {
      db.run('DELETE FROM signal_meta WHERE session_id = ?', [this.sessionId]);
      db.run('DELETE FROM signal_registration WHERE session_id = ?', [this.sessionId]);
      db.run('DELETE FROM signal_signed_prekey WHERE session_id = ?', [this.sessionId]);
      db.run('DELETE FROM signal_prekey WHERE session_id = ?', [this.sessionId]);
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
  WaSignalSqliteStore
};
