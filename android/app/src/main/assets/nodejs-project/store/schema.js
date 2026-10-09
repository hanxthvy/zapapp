// [xihanzu-NR]
'use strict';

const SCHEMA_MIGRATIONS = [
  {
    id: '0001_auth_credentials_schema',
    domain: 'auth',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS auth_credentials (
          session_id TEXT PRIMARY KEY,
          noise_pub_key BLOB NOT NULL,
          noise_priv_key BLOB NOT NULL,
          registration_id INTEGER NOT NULL,
          identity_pub_key BLOB NOT NULL,
          identity_priv_key BLOB NOT NULL,
          signed_prekey_id INTEGER NOT NULL,
          signed_prekey_pub_key BLOB NOT NULL,
          signed_prekey_priv_key BLOB NOT NULL,
          signed_prekey_signature BLOB NOT NULL,
          adv_secret_key BLOB NOT NULL,
          signed_identity BLOB,
          me_jid TEXT,
          me_lid TEXT,
          me_display_name TEXT,
          companion_enc_static BLOB,
          platform TEXT,
          server_static_key BLOB,
          server_has_prekeys INTEGER,
          routing_info BLOB,
          last_success_ts INTEGER,
          props_version INTEGER,
          ab_props_version INTEGER,
          connection_location TEXT,
          account_creation_ts INTEGER,
          device_info TEXT,
          push_name TEXT,
          year_class INTEGER,
          mem_class INTEGER
        );
      `);
    }
  },
  {
    id: '0001_signal_schema',
    domain: 'signal',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS signal_meta (
          session_id TEXT PRIMARY KEY,
          server_has_prekeys INTEGER NOT NULL DEFAULT 0,
          next_prekey_id INTEGER NOT NULL DEFAULT 1,
          signed_prekey_rotation_ts INTEGER
        );

        CREATE TABLE IF NOT EXISTS signal_registration (
          session_id TEXT PRIMARY KEY,
          registration_id INTEGER NOT NULL,
          identity_pub_key BLOB NOT NULL,
          identity_priv_key BLOB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS signal_signed_prekey (
          session_id TEXT PRIMARY KEY,
          key_id INTEGER NOT NULL,
          pub_key BLOB NOT NULL,
          priv_key BLOB NOT NULL,
          signature BLOB NOT NULL,
          uploaded INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS signal_prekey (
          session_id TEXT NOT NULL,
          key_id INTEGER NOT NULL,
          pub_key BLOB NOT NULL,
          priv_key BLOB NOT NULL,
          uploaded INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (session_id, key_id)
        );

        CREATE TABLE IF NOT EXISTS signal_session (
          session_id TEXT NOT NULL,
          user TEXT NOT NULL,
          server TEXT NOT NULL,
          device INTEGER NOT NULL,
          record BLOB NOT NULL,
          PRIMARY KEY (session_id, user, server, device)
        );

        CREATE TABLE IF NOT EXISTS signal_identity (
          session_id TEXT NOT NULL,
          user TEXT NOT NULL,
          server TEXT NOT NULL,
          device INTEGER NOT NULL,
          identity_key BLOB NOT NULL,
          PRIMARY KEY (session_id, user, server, device)
        );

        CREATE INDEX IF NOT EXISTS idx_signal_session ON signal_session(session_id, user, server, device);
        CREATE INDEX IF NOT EXISTS idx_signal_identity ON signal_identity(session_id, user, server, device);
      `);
    }
  },
  {
    id: '0001_sender_key_schema',
    domain: 'senderKey',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sender_keys (
          session_id TEXT NOT NULL,
          group_id TEXT NOT NULL,
          sender_user TEXT NOT NULL,
          sender_server TEXT NOT NULL,
          sender_device INTEGER NOT NULL,
          record BLOB NOT NULL,
          PRIMARY KEY (session_id, group_id, sender_user, sender_server, sender_device)
        );

        CREATE TABLE IF NOT EXISTS sender_key_distribution (
          session_id TEXT NOT NULL,
          group_id TEXT NOT NULL,
          sender_user TEXT NOT NULL,
          sender_server TEXT NOT NULL,
          sender_device INTEGER NOT NULL,
          key_id INTEGER NOT NULL,
          timestamp_ms INTEGER NOT NULL,
          PRIMARY KEY (session_id, group_id, sender_user, sender_server, sender_device)
        );
      `);
    }
  },
  {
    id: '0004_mailbox_schema',
    domain: 'mailbox',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mailbox_messages (
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          thread_jid TEXT NOT NULL,
          sender_jid TEXT,
          participant_jid TEXT,
          from_me INTEGER NOT NULL,
          timestamp_ms INTEGER,
          message_bytes BLOB,
          PRIMARY KEY (session_id, message_id)
        );

        CREATE INDEX IF NOT EXISTS mailbox_messages_by_thread_timestamp
          ON mailbox_messages (session_id, thread_jid, timestamp_ms DESC);

        CREATE TABLE IF NOT EXISTS mailbox_threads (
          session_id TEXT NOT NULL,
          jid TEXT NOT NULL,
          name TEXT,
          unread_count INTEGER,
          archived INTEGER,
          pinned INTEGER,
          mute_end_ms INTEGER,
          marked_as_unread INTEGER,
          ephemeral_expiration INTEGER,
          PRIMARY KEY (session_id, jid)
        );

        CREATE TABLE IF NOT EXISTS mailbox_contacts (
          session_id TEXT NOT NULL,
          jid TEXT NOT NULL,
          display_name TEXT,
          push_name TEXT,
          lid TEXT,
          phone_number TEXT,
          last_updated_ms INTEGER NOT NULL,
          PRIMARY KEY (session_id, jid)
        );
      `);
    }
  }
];

function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wa_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
}

function hasMigration(db, id) {
  const row = db.get('SELECT id FROM wa_migrations WHERE id = ?', [id]);
  return !!row;
}

async function ensureSqliteMigrations(db, domains, logger) {
  ensureMigrationTable(db);
  const domainSet = domains && domains.length > 0 ? new Set(domains) : null;

  for (const migration of SCHEMA_MIGRATIONS) {
    if (domainSet && !domainSet.has(migration.domain)) {
      continue;
    }
    if (hasMigration(db, migration.id)) {
      continue;
    }

    await db.runInTransaction(() => {
      if (hasMigration(db, migration.id)) return;
      migration.up(db);
      db.run('INSERT INTO wa_migrations (id, applied_at) VALUES (?, ?)', [
        migration.id,
        Date.now()
      ]);
    });

    if (logger && typeof logger.info === 'function') {
      logger.info('Applied migration', { id: migration.id, domain: migration.domain });
    }
  }
}

module.exports = {
  SCHEMA_MIGRATIONS,
  ensureSqliteMigrations
};
