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
      ) VALUES (?, ?, ?, ?)`,
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
      ) VALUES (?, ?, ?, ?, ?, ?)`,
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
       VALUES (?, ?)`,
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
  async putPreKey(record) {
    const db = await this.getConnection();
    db.run(
      `INSERT INTO signal_prekey (
        session_id, key_id, pub_key, priv_key, uploaded
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        this.sessionId,
        record.keyId,
        Buffer.from(record.keyPair.pubKey),
        Buffer.from(record.keyPair.privKey),
        record.uploaded ? 1 : 0
      ]
    );
  }

  async getPreKeyById(keyId) {
    const db = await this.getConnection();
    const row = db.get(
      `SELECT key_id, pub_key, priv_key, uploaded
       FROM signal_prekey
       WHERE session_id = ? AND key_id = ?`,
      [this.sessionId, keyId]
    );
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

  async consumePreKeyById(keyId) {
    const record = await this.getPreKeyById(keyId);
    if (!record) return null;
    const db = await this.getConnection();
    db.run('DELETE FROM signal_prekey WHERE session_id = ? AND key_id = ?', [this.sessionId, keyId]);
    return record;
  }

  async markKeyAsUploaded(keyId) {
    const db = await this.getConnection();
    db.run('UPDATE signal_prekey SET uploaded = 1 WHERE session_id = ? AND key_id = ?', [this.sessionId, keyId]);
  }

  async setServerHasPreKeys(value) {
    const db = await this.getConnection();
    db.run(
      `INSERT INTO signal_meta (session_id, server_has_prekeys)
       VALUES (?, ?)`,
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
