// [xihanzu-NR]
'use strict';

const { openSqliteConnection } = require('./connection');
const { ensureSqliteMigrations } = require('./schema');
const {
  asBytes,
  asNumber,
  asOptionalBytes,
  asOptionalNumber,
  asOptionalString,
  toBoolOrUndef
} = require('./utils');

class WaAuthSqliteStore {
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
        await ensureSqliteMigrations(conn, ['auth'], this.logger);
        return conn;
      })();
    }
    return this._connPromise;
  }

  async load() {
    const db = await this.getConnection();
    const row = db.get(
      `SELECT
        noise_pub_key,
        noise_priv_key,
        registration_id,
        identity_pub_key,
        identity_priv_key,
        signed_prekey_id,
        signed_prekey_pub_key,
        signed_prekey_priv_key,
        signed_prekey_signature,
        adv_secret_key,
        signed_identity,
        me_jid,
        me_lid,
        me_display_name,
        companion_enc_static,
        platform,
        server_static_key,
        server_has_prekeys,
        routing_info,
        last_success_ts,
        props_version,
        ab_props_version,
        connection_location,
        account_creation_ts,
        device_info,
        push_name,
        year_class,
        mem_class
      FROM auth_credentials
      WHERE session_id = ?`,
      [this.sessionId]
    );

    if (!row) {
      return null;
    }

    const signedIdentityBytes = asOptionalBytes(row.signed_identity);
    const deviceInfoJson = asOptionalString(row.device_info);

    return {
      noiseKeyPair: {
        pubKey: asBytes(row.noise_pub_key, 'noise_pub_key'),
        privKey: asBytes(row.noise_priv_key, 'noise_priv_key')
      },
      registrationInfo: {
        registrationId: asNumber(row.registration_id, 'registration_id'),
        identityKeyPair: {
          pubKey: asBytes(row.identity_pub_key, 'identity_pub_key'),
          privKey: asBytes(row.identity_priv_key, 'identity_priv_key')
        }
      },
      signedPreKey: {
        keyId: asNumber(row.signed_prekey_id, 'signed_prekey_id'),
        keyPair: {
          pubKey: asBytes(row.signed_prekey_pub_key, 'signed_prekey_pub_key'),
          privKey: asBytes(row.signed_prekey_priv_key, 'signed_prekey_priv_key')
        },
        signature: asBytes(row.signed_prekey_signature, 'signed_prekey_signature'),
        uploaded: false
      },
      advSecretKey: asBytes(row.adv_secret_key, 'adv_secret_key'),
      signedIdentity: signedIdentityBytes || undefined,
      meJid: asOptionalString(row.me_jid),
      meLid: asOptionalString(row.me_lid),
      meDisplayName: asOptionalString(row.me_display_name),
      companionEncStatic: asOptionalBytes(row.companion_enc_static),
      platform: asOptionalString(row.platform),
      serverStaticKey: asOptionalBytes(row.server_static_key),
      serverHasPreKeys: toBoolOrUndef(row.server_has_prekeys),
      routingInfo: asOptionalBytes(row.routing_info),
      lastSuccessTs: asOptionalNumber(row.last_success_ts),
      propsVersion: asOptionalNumber(row.props_version),
      abPropsVersion: asOptionalNumber(row.ab_props_version),
      connectionLocation: asOptionalString(row.connection_location),
      accountCreationTs: asOptionalNumber(row.account_creation_ts),
      deviceInfo: deviceInfoJson ? JSON.parse(deviceInfoJson) : undefined,
      pushName: asOptionalString(row.push_name),
      yearClass: asOptionalNumber(row.year_class),
      memClass: asOptionalNumber(row.mem_class)
    };
  }

  async save(credentials) {
    const db = await this.getConnection();
    await db.runInTransaction(() => {
      db.run(
        `INSERT INTO auth_credentials (
          session_id,
          noise_pub_key,
          noise_priv_key,
          registration_id,
          identity_pub_key,
          identity_priv_key,
          signed_prekey_id,
          signed_prekey_pub_key,
          signed_prekey_priv_key,
          signed_prekey_signature,
          adv_secret_key,
          signed_identity,
          me_jid,
          me_lid,
          me_display_name,
          companion_enc_static,
          platform,
          server_static_key,
          server_has_prekeys,
          routing_info,
          last_success_ts,
          props_version,
          ab_props_version,
          connection_location,
          account_creation_ts,
          device_info,
          push_name,
          year_class,
          mem_class
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(session_id) DO UPDATE SET
          noise_pub_key=excluded.noise_pub_key,
          noise_priv_key=excluded.noise_priv_key,
          registration_id=excluded.registration_id,
          identity_pub_key=excluded.identity_pub_key,
          identity_priv_key=excluded.identity_priv_key,
          signed_prekey_id=excluded.signed_prekey_id,
          signed_prekey_pub_key=excluded.signed_prekey_pub_key,
          signed_prekey_priv_key=excluded.signed_prekey_priv_key,
          signed_prekey_signature=excluded.signed_prekey_signature,
          adv_secret_key=excluded.adv_secret_key,
          signed_identity=excluded.signed_identity,
          me_jid=excluded.me_jid,
          me_lid=excluded.me_lid,
          me_display_name=excluded.me_display_name,
          companion_enc_static=excluded.companion_enc_static,
          platform=excluded.platform,
          server_static_key=excluded.server_static_key,
          server_has_prekeys=excluded.server_has_prekeys,
          routing_info=excluded.routing_info,
          last_success_ts=excluded.last_success_ts,
          props_version=excluded.props_version,
          ab_props_version=excluded.ab_props_version,
          connection_location=excluded.connection_location,
          account_creation_ts=excluded.account_creation_ts,
          device_info=excluded.device_info,
          push_name=excluded.push_name,
          year_class=excluded.year_class,
          mem_class=excluded.mem_class`,
        [
          this.sessionId,
          credentials.noiseKeyPair.pubKey,
          credentials.noiseKeyPair.privKey,
          credentials.registrationInfo.registrationId,
          credentials.registrationInfo.identityKeyPair.pubKey,
          credentials.registrationInfo.identityKeyPair.privKey,
          credentials.signedPreKey.keyId,
          credentials.signedPreKey.keyPair.pubKey,
          credentials.signedPreKey.keyPair.privKey,
          credentials.signedPreKey.signature,
          credentials.advSecretKey,
          credentials.signedIdentity ? Buffer.from(credentials.signedIdentity) : null,
          credentials.meJid || null,
          credentials.meLid || null,
          credentials.meDisplayName || null,
          credentials.companionEncStatic || null,
          credentials.platform || null,
          credentials.serverStaticKey || null,
          credentials.serverHasPreKeys === undefined ? null : credentials.serverHasPreKeys ? 1 : 0,
          credentials.routingInfo || null,
          credentials.lastSuccessTs || null,
          credentials.propsVersion || null,
          credentials.abPropsVersion || null,
          credentials.connectionLocation || null,
          credentials.accountCreationTs || null,
          credentials.deviceInfo ? JSON.stringify(credentials.deviceInfo) : null,
          credentials.pushName || null,
          credentials.yearClass || null,
          credentials.memClass || null
        ]
      );
    });
  }

  async clear() {
    const db = await this.getConnection();
    await db.runInTransaction(() => {
      db.run('DELETE FROM auth_credentials WHERE session_id = ?', [this.sessionId]);
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
  WaAuthSqliteStore
};
