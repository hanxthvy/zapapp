// [xihanzu-NR]
//! SQLite database operations and CRUD repository for zapapp.

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::store::schema::{
    run_migrations, AuthCredentials, MessageRecord, MessageStatus, PreKeyRecord, RecentChat,
    SenderKeyRecord, SessionRecord, SignalIdentity, StoreError,
};

fn now_epoch_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// SQLite store instance wrapping a thread-safe connection.
#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    /// Opens or creates a SQLite database at the specified path and runs migrations.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let mut conn = Connection::open(path)?;
        Self::configure_connection(&mut conn)?;
        run_migrations(&mut conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Opens an in-memory SQLite database and runs migrations.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let mut conn = Connection::open_in_memory()?;
        Self::configure_connection(&mut conn)?;
        run_migrations(&mut conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn configure_connection(conn: &mut Connection) -> Result<(), StoreError> {
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;
            "#,
        )?;
        Ok(())
    }

    /// Executes a closure with a mutable reference to the underlying connection.
    pub fn with_conn<F, R>(&self, f: F) -> Result<R, StoreError>
    where
        F: FnOnce(&mut Connection) -> Result<R, StoreError>,
    {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        f(&mut conn)
    }

    // =========================================================================
    // Auth Credentials & Session Tokens
    // =========================================================================

    /// Saves or updates authentication credentials.
    pub fn save_auth_credentials(&self, creds: &AuthCredentials) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            conn.execute(
                r#"
                INSERT INTO auth_credentials (
                    id, registration_id, noise_key, identity_key, signed_prekey,
                    signed_prekey_id, signed_prekey_sig, adv_secret_key, me_jid,
                    me_lid, me_name, account_sync_counter, platform, tokens,
                    created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                ON CONFLICT(id) DO UPDATE SET
                    registration_id = excluded.registration_id,
                    noise_key = excluded.noise_key,
                    identity_key = excluded.identity_key,
                    signed_prekey = excluded.signed_prekey,
                    signed_prekey_id = excluded.signed_prekey_id,
                    signed_prekey_sig = excluded.signed_prekey_sig,
                    adv_secret_key = excluded.adv_secret_key,
                    me_jid = excluded.me_jid,
                    me_lid = excluded.me_lid,
                    me_name = excluded.me_name,
                    account_sync_counter = excluded.account_sync_counter,
                    platform = excluded.platform,
                    tokens = excluded.tokens,
                    updated_at = excluded.updated_at
                "#,
                params![
                    creds.id,
                    creds.registration_id,
                    creds.noise_key,
                    creds.identity_key,
                    creds.signed_prekey,
                    creds.signed_prekey_id,
                    creds.signed_prekey_sig,
                    creds.adv_secret_key,
                    creds.me_jid,
                    creds.me_lid,
                    creds.me_name,
                    creds.account_sync_counter,
                    creds.platform,
                    creds.tokens,
                    creds.created_at,
                    creds.updated_at,
                ],
            )?;
            Ok(())
        })
    }

    /// Retrieves authentication credentials by identifier.
    pub fn get_auth_credentials(&self, id: &str) -> Result<Option<AuthCredentials>, StoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                r#"
                SELECT id, registration_id, noise_key, identity_key, signed_prekey,
                       signed_prekey_id, signed_prekey_sig, adv_secret_key, me_jid,
                       me_lid, me_name, account_sync_counter, platform, tokens,
                       created_at, updated_at
                FROM auth_credentials
                WHERE id = ?1
                "#,
            )?;

            let creds = stmt
                .query_row(params![id], Self::map_auth_credentials_row)
                .optional()?;

            Ok(creds)
        })
    }

    /// Deletes authentication credentials by identifier.
    pub fn delete_auth_credentials(&self, id: &str) -> Result<bool, StoreError> {
        self.with_conn(|conn| {
            let count = conn.execute("DELETE FROM auth_credentials WHERE id = ?1", params![id])?;
            Ok(count > 0)
        })
    }

    /// Lists all authentication credentials.
    pub fn list_auth_credentials(&self) -> Result<Vec<AuthCredentials>, StoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                r#"
                SELECT id, registration_id, noise_key, identity_key, signed_prekey,
                       signed_prekey_id, signed_prekey_sig, adv_secret_key, me_jid,
                       me_lid, me_name, account_sync_counter, platform, tokens,
                       created_at, updated_at
                FROM auth_credentials
                ORDER BY created_at ASC
                "#,
            )?;

            let rows = stmt.query_map([], Self::map_auth_credentials_row)?;
            let mut result = Vec::new();
            for r in rows {
                result.push(r?);
            }
            Ok(result)
        })
    }

    /// Stores or updates session token string for the given credential id.
    pub fn save_session_token(&self, id: &str, tokens: &str) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            let now = now_epoch_secs();
            let count = conn.execute(
                "UPDATE auth_credentials SET tokens = ?1, updated_at = ?2 WHERE id = ?3",
                params![tokens, now, id],
            )?;
            if count == 0 {
                Err(StoreError::NotFound(format!("auth credential {id} not found")))
            } else {
                Ok(())
            }
        })
    }

    /// Retrieves session token string for the given credential id.
    pub fn get_session_token(&self, id: &str) -> Result<Option<String>, StoreError> {
        self.with_conn(|conn| {
            let token: Option<Option<String>> = conn
                .query_row(
                    "SELECT tokens FROM auth_credentials WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()?;
            Ok(token.flatten())
        })
    }

    /// Updates authenticated user identity info.
    pub fn update_me(
        &self,
        id: &str,
        jid: &str,
        lid: Option<&str>,
        name: Option<&str>,
    ) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            let now = now_epoch_secs();
            conn.execute(
                r#"
                UPDATE auth_credentials
                SET me_jid = ?1, me_lid = ?2, me_name = ?3, updated_at = ?4
                WHERE id = ?5
                "#,
                params![jid, lid, name, now, id],
            )?;
            Ok(())
        })
    }

    fn map_auth_credentials_row(row: &Row) -> rusqlite::Result<AuthCredentials> {
        Ok(AuthCredentials {
            id: row.get(0)?,
            registration_id: row.get(1)?,
            noise_key: row.get(2)?,
            identity_key: row.get(3)?,
            signed_prekey: row.get(4)?,
            signed_prekey_id: row.get(5)?,
            signed_prekey_sig: row.get(6)?,
            adv_secret_key: row.get(7)?,
            me_jid: row.get(8)?,
            me_lid: row.get(9)?,
            me_name: row.get(10)?,
            account_sync_counter: row.get(11)?,
            platform: row.get(12)?,
            tokens: row.get(13)?,
            created_at: row.get(14)?,
            updated_at: row.get(15)?,
        })
    }

    // =========================================================================
    // Signal Identities
    // =========================================================================

    /// Saves or updates a peer Signal identity key.
    pub fn save_identity(&self, identity: &SignalIdentity) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            conn.execute(
                r#"
                INSERT INTO signal_identities (address, identity_key, is_trusted, added_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(address) DO UPDATE SET
                    identity_key = excluded.identity_key,
                    is_trusted = excluded.is_trusted,
                    updated_at = excluded.updated_at
                "#,
                params![
                    identity.address,
                    identity.identity_key,
                    if identity.is_trusted { 1 } else { 0 },
                    identity.added_at,
                    identity.updated_at,
                ],
            )?;
            Ok(())
        })
    }

    /// Retrieves a peer Signal identity key by address.
    pub fn get_identity(&self, address: &str) -> Result<Option<SignalIdentity>, StoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT address, identity_key, is_trusted, added_at, updated_at FROM signal_identities WHERE address = ?1",
            )?;
            let id = stmt
                .query_row(params![address], Self::map_signal_identity_row)
                .optional()?;
            Ok(id)
        })
    }

    /// Deletes a peer Signal identity key by address.
    pub fn delete_identity(&self, address: &str) -> Result<bool, StoreError> {
        self.with_conn(|conn| {
            let count = conn.execute(
                "DELETE FROM signal_identities WHERE address = ?1",
                params![address],
            )?;
            Ok(count > 0)
        })
    }

    /// Lists all stored Signal identities.
    pub fn list_identities(&self) -> Result<Vec<SignalIdentity>, StoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT address, identity_key, is_trusted, added_at, updated_at FROM signal_identities ORDER BY added_at DESC",
            )?;
            let rows = stmt.query_map([], Self::map_signal_identity_row)?;
            let mut list = Vec::new();
            for r in rows {
                list.push(r?);
            }
            Ok(list)
        })
    }

    /// Verifies if an identity key is trusted for the given address (TOFU model).
    pub fn is_trusted_identity(&self, address: &str, identity_key: &[u8]) -> Result<bool, StoreError> {
        match self.get_identity(address)? {
            None => Ok(true), // Trust On First Use
            Some(stored) => Ok(stored.is_trusted && stored.identity_key == identity_key),
        }
    }

    fn map_signal_identity_row(row: &Row) -> rusqlite::Result<SignalIdentity> {
        let is_trusted_int: i32 = row.get(2)?;
        Ok(SignalIdentity {
            address: row.get(0)?,
            identity_key: row.get(1)?,
            is_trusted: is_trusted_int != 0,
            added_at: row.get(3)?,
            updated_at: row.get(4)?,
        })
    }

    // =========================================================================
    // Pre-Keys
    // =========================================================================

    /// Saves or updates a one-time pre-key.
    pub fn save_pre_key(&self, pre_key: &PreKeyRecord) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            conn.execute(
                r#"
                INSERT INTO pre_keys (key_id, key_pair, public_key, is_uploaded, is_consumed, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(key_id) DO UPDATE SET
                    key_pair = excluded.key_pair,
                    public_key = excluded.public_key,
                    is_uploaded = excluded.is_uploaded,
                    is_consumed = excluded.is_consumed
                "#,
                params![
                    pre_key.key_id,
                    pre_key.key_pair,
                    pre_key.public_key,
                    if pre_key.is_uploaded { 1 } else { 0 },
                    if pre_key.is_consumed { 1 } else { 0 },
                    pre_key.created_at,
                ],
            )?;
            Ok(())
        })
    }

    /// Saves a batch of one-time pre-keys in a single transaction.
    pub fn save_pre_keys_batch(&self, keys: &[PreKeyRecord]) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            let tx = conn.transaction()?;
            {
                let mut stmt = tx.prepare(
                    r#"
                    INSERT INTO pre_keys (key_id, key_pair, public_key, is_uploaded, is_consumed, created_at)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                    ON CONFLICT(key_id) DO UPDATE SET
                        key_pair = excluded.key_pair,
                        public_key = excluded.public_key,
                        is_uploaded = excluded.is_uploaded,
                        is_consumed = excluded.is_consumed
                    "#,
                )?;
                for key in keys {
                    stmt.execute(params![
                        key.key_id,
                        key.key_pair,
                        key.public_key,
                        if key.is_uploaded { 1 } else { 0 },
                        if key.is_consumed { 1 } else { 0 },
                        key.created_at,
                    ])?;
                }
            }
            tx.commit()?;
            Ok(())
        })
    }

    /// Retrieves a pre-key by key ID.
    pub fn get_pre_key(&self, key_id: u32) -> Result<Option<PreKeyRecord>, StoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT key_id, key_pair, public_key, is_uploaded, is_consumed, created_at FROM pre_keys WHERE key_id = ?1",
            )?;
            let key = stmt
                .query_row(params![key_id], Self::map_pre_key_row)
                .optional()?;
            Ok(key)
        })
    }

    /// Deletes a pre-key by key ID.
    pub fn delete_pre_key(&self, key_id: u32) -> Result<bool, StoreError> {
        self.with_conn(|conn| {
            let count = conn.execute("DELETE FROM pre_keys WHERE key_id = ?1", params![key_id])?;
            Ok(count > 0)
        })
    }

    /// Marks a pre-key as consumed.
    pub fn mark_pre_key_consumed(&self, key_id: u32) -> Result<bool, StoreError> {
        self.with_conn(|conn| {
            let count = conn.execute(
                "UPDATE pre_keys SET is_consumed = 1 WHERE key_id = ?1",
                params![key_id],
            )?;
            Ok(count > 0)
        })
    }

    /// Retrieves unconsumed pre-keys up to limit.
    pub fn get_available_pre_keys(&self, limit: u32) -> Result<Vec<PreKeyRecord>, StoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                r#"
                SELECT key_id, key_pair, public_key, is_uploaded, is_consumed, created_at
                FROM pre_keys
                WHERE is_consumed = 0
                ORDER BY key_id ASC
                LIMIT ?1
                "#,
            )?;
            let rows = stmt.query_map(params![limit], Self::map_pre_key_row)?;
            let mut list = Vec::new();
            for r in rows {
                list.push(r?);
            }
            Ok(list)
        })
    }

    /// Returns the number of unconsumed pre-keys.
    pub fn count_available_pre_keys(&self) -> Result<u32, StoreError> {
        self.with_conn(|conn| {
            let count: u32 = conn.query_row(
                "SELECT COUNT(*) FROM pre_keys WHERE is_consumed = 0",
                [],
                |row| row.get(0),
            )?;
            Ok(count)
        })
    }

    fn map_pre_key_row(row: &Row) -> rusqlite::Result<PreKeyRecord> {
        let is_uploaded_int: i32 = row.get(3)?;
        let is_consumed_int: i32 = row.get(4)?;
        Ok(PreKeyRecord {
            key_id: row.get(0)?,
            key_pair: row.get(1)?,
            public_key: row.get(2)?,
            is_uploaded: is_uploaded_int != 0,
            is_consumed: is_consumed_int != 0,
            created_at: row.get(5)?,
        })
    }

    // =========================================================================
    // Session Records
    // =========================================================================

    /// Saves or updates a Signal ratchet session record.
    pub fn save_session(&self, session: &SessionRecord) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            conn.execute(
                r#"
                INSERT INTO session_records (session_id, record, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(session_id) DO UPDATE SET
                    record = excluded.record,
                    updated_at = excluded.updated_at
                "#,
                params![
                    session.session_id,
                    session.record,
                    session.created_at,
                    session.updated_at,
                ],
            )?;
            Ok(())
        })
    }

    /// Retrieves a Signal session record by session identifier.
    pub fn get_session(&self, session_id: &str) -> Result<Option<SessionRecord>, StoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT session_id, record, created_at, updated_at FROM session_records WHERE session_id = ?1",
            )?;
            let sess = stmt
                .query_row(params![session_id], Self::map_session_row)
                .optional()?;
            Ok(sess)
        })
    }

    /// Checks if a session record exists.
    pub fn has_session(&self, session_id: &str) -> Result<bool, StoreError> {
        self.with_conn(|conn| {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM session_records WHERE session_id = ?1)",
                params![session_id],
                |row| row.get(0),
            )?;
            Ok(exists)
        })
    }

    /// Deletes a session record by session identifier.
    pub fn delete_session(&self, session_id: &str) -> Result<bool, StoreError> {
        self.with_conn(|conn| {
            let count = conn.execute(
                "DELETE FROM session_records WHERE session_id = ?1",
                params![session_id],
            )?;
            Ok(count > 0)
        })
    }

    /// Lists all session records.
    pub fn list_sessions(&self) -> Result<Vec<SessionRecord>, StoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT session_id, record, created_at, updated_at FROM session_records ORDER BY updated_at DESC",
            )?;
            let rows = stmt.query_map([], Self::map_session_row)?;
            let mut list = Vec::new();
            for r in rows {
                list.push(r?);
            }
            Ok(list)
        })
    }

    fn map_session_row(row: &Row) -> rusqlite::Result<SessionRecord> {
        Ok(SessionRecord {
            session_id: row.get(0)?,
            record: row.get(1)?,
            created_at: row.get(2)?,
            updated_at: row.get(3)?,
        })
    }

    // =========================================================================
    // Sender Keys (Group Ratchet)
    // =========================================================================

    /// Saves or updates a group sender key record.
    pub fn save_sender_key(&self, sender_key: &SenderKeyRecord) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            conn.execute(
                r#"
                INSERT INTO sender_keys (group_id, sender_id, record, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(group_id, sender_id) DO UPDATE SET
                    record = excluded.record,
                    updated_at = excluded.updated_at
                "#,
                params![
                    sender_key.group_id,
                    sender_key.sender_id,
                    sender_key.record,
                    sender_key.created_at,
                    sender_key.updated_at,
                ],
            )?;
            Ok(())
        })
    }

    /// Retrieves a group sender key by group ID and sender ID.
    pub fn get_sender_key(
        &self,
        group_id: &str,
        sender_id: &str,
    ) -> Result<Option<SenderKeyRecord>, StoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT group_id, sender_id, record, created_at, updated_at FROM sender_keys WHERE group_id = ?1 AND sender_id = ?2",
            )?;
            let key = stmt
                .query_row(params![group_id, sender_id], Self::map_sender_key_row)
                .optional()?;
            Ok(key)
        })
    }

    /// Deletes a sender key for a specific sender in a group.
    pub fn delete_sender_key(&self, group_id: &str, sender_id: &str) -> Result<bool, StoreError> {
        self.with_conn(|conn| {
            let count = conn.execute(
                "DELETE FROM sender_keys WHERE group_id = ?1 AND sender_id = ?2",
                params![group_id, sender_id],
            )?;
            Ok(count > 0)
        })
    }

    /// Deletes all sender keys for a group.
    pub fn delete_group_sender_keys(&self, group_id: &str) -> Result<usize, StoreError> {
        self.with_conn(|conn| {
            let count = conn.execute(
                "DELETE FROM sender_keys WHERE group_id = ?1",
                params![group_id],
            )?;
            Ok(count)
        })
    }

    /// Lists all sender keys within a group.
    pub fn list_sender_keys(&self, group_id: &str) -> Result<Vec<SenderKeyRecord>, StoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT group_id, sender_id, record, created_at, updated_at FROM sender_keys WHERE group_id = ?1 ORDER BY updated_at DESC",
            )?;
            let rows = stmt.query_map(params![group_id], Self::map_sender_key_row)?;
            let mut list = Vec::new();
            for r in rows {
                list.push(r?);
            }
            Ok(list)
        })
    }

    fn map_sender_key_row(row: &Row) -> rusqlite::Result<SenderKeyRecord> {
        Ok(SenderKeyRecord {
            group_id: row.get(0)?,
            sender_id: row.get(1)?,
            record: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        })
    }

    // =========================================================================
    // Chat Message History
    // =========================================================================

    /// Inserts or updates a chat message record.
    pub fn insert_message(&self, msg: &MessageRecord) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            conn.execute(
                r#"
                INSERT INTO messages (
                    id, chat_jid, sender_jid, from_me, timestamp, status,
                    message_type, content, raw_payload, media_url, media_mime,
                    media_size, quoted_id, is_starred, is_deleted
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                ON CONFLICT(id) DO UPDATE SET
                    status = excluded.status,
                    content = excluded.content,
                    raw_payload = excluded.raw_payload,
                    media_url = excluded.media_url,
                    media_mime = excluded.media_mime,
                    media_size = excluded.media_size,
                    is_starred = excluded.is_starred,
                    is_deleted = excluded.is_deleted
                "#,
                params![
                    msg.id,
                    msg.chat_jid,
                    msg.sender_jid,
                    if msg.from_me { 1 } else { 0 },
                    msg.timestamp,
                    msg.status.as_str(),
                    msg.message_type,
                    msg.content,
                    msg.raw_payload,
                    msg.media_url,
                    msg.media_mime,
                    msg.media_size,
                    msg.quoted_id,
                    if msg.is_starred { 1 } else { 0 },
                    if msg.is_deleted { 1 } else { 0 },
                ],
            )?;
            Ok(())
        })
    }

    /// Retrieves a single message by ID.
    pub fn get_message(&self, id: &str) -> Result<Option<MessageRecord>, StoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                r#"
                SELECT id, chat_jid, sender_jid, from_me, timestamp, status,
                       message_type, content, raw_payload, media_url, media_mime,
                       media_size, quoted_id, is_starred, is_deleted
                FROM messages
                WHERE id = ?1
                "#,
            )?;
            let msg = stmt
                .query_row(params![id], Self::map_message_row)
                .optional()?;
            Ok(msg)
        })
    }

    /// Updates the delivery / read status of a message.
    pub fn update_message_status(
        &self,
        id: &str,
        status: MessageStatus,
    ) -> Result<bool, StoreError> {
        self.with_conn(|conn| {
            let count = conn.execute(
                "UPDATE messages SET status = ?1 WHERE id = ?2",
                params![status.as_str(), id],
            )?;
            Ok(count > 0)
        })
    }

    /// Updates the text content of a message (e.g. on message edit).
    pub fn update_message_content(&self, id: &str, content: &str) -> Result<bool, StoreError> {
        self.with_conn(|conn| {
            let count = conn.execute(
                "UPDATE messages SET content = ?1 WHERE id = ?2",
                params![content, id],
            )?;
            Ok(count > 0)
        })
    }

    /// Deletes a message (soft-delete sets `is_deleted = 1`, hard-delete removes row).
    pub fn delete_message(&self, id: &str, soft: bool) -> Result<bool, StoreError> {
        self.with_conn(|conn| {
            let count = if soft {
                conn.execute(
                    "UPDATE messages SET is_deleted = 1, content = NULL, raw_payload = NULL WHERE id = ?1",
                    params![id],
                )?
            } else {
                conn.execute("DELETE FROM messages WHERE id = ?1", params![id])?
            };
            Ok(count > 0)
        })
    }

    /// Fetches paginated chat messages for a chat JID ordered chronologically (newest first).
    pub fn get_chat_messages(
        &self,
        chat_jid: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<MessageRecord>, StoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                r#"
                SELECT id, chat_jid, sender_jid, from_me, timestamp, status,
                       message_type, content, raw_payload, media_url, media_mime,
                       media_size, quoted_id, is_starred, is_deleted
                FROM messages
                WHERE chat_jid = ?1 AND is_deleted = 0
                ORDER BY timestamp DESC
                LIMIT ?2 OFFSET ?3
                "#,
            )?;
            let rows = stmt.query_map(params![chat_jid, limit, offset], Self::map_message_row)?;
            let mut list = Vec::new();
            for r in rows {
                list.push(r?);
            }
            Ok(list)
        })
    }

    /// Fetches messages prior to a given timestamp for infinite scrolling.
    pub fn get_chat_messages_before(
        &self,
        chat_jid: &str,
        before_timestamp: i64,
        limit: u32,
    ) -> Result<Vec<MessageRecord>, StoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                r#"
                SELECT id, chat_jid, sender_jid, from_me, timestamp, status,
                       message_type, content, raw_payload, media_url, media_mime,
                       media_size, quoted_id, is_starred, is_deleted
                FROM messages
                WHERE chat_jid = ?1 AND timestamp < ?2 AND is_deleted = 0
                ORDER BY timestamp DESC
                LIMIT ?3
                "#,
            )?;
            let rows = stmt.query_map(
                params![chat_jid, before_timestamp, limit],
                Self::map_message_row,
            )?;
            let mut list = Vec::new();
            for r in rows {
                list.push(r?);
            }
            Ok(list)
        })
    }

    /// Searches text messages across all chats or a specific chat.
    pub fn search_messages(&self, query: &str, limit: u32) -> Result<Vec<MessageRecord>, StoreError> {
        self.with_conn(|conn| {
            let like_query = format!("%{query}%");
            let mut stmt = conn.prepare(
                r#"
                SELECT id, chat_jid, sender_jid, from_me, timestamp, status,
                       message_type, content, raw_payload, media_url, media_mime,
                       media_size, quoted_id, is_starred, is_deleted
                FROM messages
                WHERE content LIKE ?1 AND is_deleted = 0
                ORDER BY timestamp DESC
                LIMIT ?2
                "#,
            )?;
            let rows = stmt.query_map(params![like_query, limit], Self::map_message_row)?;
            let mut list = Vec::new();
            for r in rows {
                list.push(r?);
            }
            Ok(list)
        })
    }

    /// Counts unread incoming messages in a chat.
    pub fn get_unread_count(&self, chat_jid: &str) -> Result<u32, StoreError> {
        self.with_conn(|conn| {
            let count: u32 = conn.query_row(
                r#"
                SELECT COUNT(*) FROM messages
                WHERE chat_jid = ?1 AND from_me = 0
                  AND status NOT IN ('read', 'played')
                  AND is_deleted = 0
                "#,
                params![chat_jid],
                |row| row.get(0),
            )?;
            Ok(count)
        })
    }

    /// Marks all unread incoming messages in a chat as read.
    pub fn mark_chat_as_read(&self, chat_jid: &str) -> Result<usize, StoreError> {
        self.with_conn(|conn| {
            let count = conn.execute(
                r#"
                UPDATE messages
                SET status = 'read'
                WHERE chat_jid = ?1 AND from_me = 0
                  AND status NOT IN ('read', 'played')
                  AND is_deleted = 0
                "#,
                params![chat_jid],
            )?;
            Ok(count)
        })
    }

    /// Counts all active messages in a chat.
    pub fn count_messages_in_chat(&self, chat_jid: &str) -> Result<u32, StoreError> {
        self.with_conn(|conn| {
            let count: u32 = conn.query_row(
                "SELECT COUNT(*) FROM messages WHERE chat_jid = ?1 AND is_deleted = 0",
                params![chat_jid],
                |row| row.get(0),
            )?;
            Ok(count)
        })
    }

    /// Returns a list of recent active chat conversations with last message and unread count.
    pub fn get_recent_chats(&self, limit: u32) -> Result<Vec<RecentChat>, StoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                r#"
                WITH RankedMessages AS (
                    SELECT m.*,
                           ROW_NUMBER() OVER (PARTITION BY chat_jid ORDER BY timestamp DESC) as rn
                    FROM messages m
                    WHERE is_deleted = 0
                ),
                UnreadCounts AS (
                    SELECT chat_jid, COUNT(*) as unread
                    FROM messages
                    WHERE from_me = 0 AND status NOT IN ('read', 'played') AND is_deleted = 0
                    GROUP BY chat_jid
                )
                SELECT r.chat_jid, r.id, r.content, r.timestamp, COALESCE(u.unread, 0)
                FROM RankedMessages r
                LEFT JOIN UnreadCounts u ON r.chat_jid = u.chat_jid
                WHERE r.rn = 1
                ORDER BY r.timestamp DESC
                LIMIT ?1
                "#,
            )?;

            let rows = stmt.query_map(params![limit], |row| {
                let unread: u32 = row.get(4)?;
                Ok(RecentChat {
                    chat_jid: row.get(0)?,
                    last_message_id: row.get(1)?,
                    last_content: row.get(2)?,
                    last_timestamp: row.get(3)?,
                    unread_count: unread,
                })
            })?;

            let mut list = Vec::new();
            for r in rows {
                list.push(r?);
            }
            Ok(list)
        })
    }

    fn map_message_row(row: &Row) -> rusqlite::Result<MessageRecord> {
        let from_me_int: i32 = row.get(3)?;
        let status_str: String = row.get(5)?;
        let is_starred_int: i32 = row.get(13)?;
        let is_deleted_int: i32 = row.get(14)?;

        let status = MessageStatus::from_str(&status_str)
            .map_err(|e| rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(e)))?;

        Ok(MessageRecord {
            id: row.get(0)?,
            chat_jid: row.get(1)?,
            sender_jid: row.get(2)?,
            from_me: from_me_int != 0,
            timestamp: row.get(4)?,
            status,
            message_type: row.get(6)?,
            content: row.get(7)?,
            raw_payload: row.get(8)?,
            media_url: row.get(9)?,
            media_mime: row.get(10)?,
            media_size: row.get(11)?,
            quoted_id: row.get(12)?,
            is_starred: is_starred_int != 0,
            is_deleted: is_deleted_int != 0,
        })
    }
}
