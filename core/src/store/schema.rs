// [xihanzu-NR]
//! SQLite database schema, data models, and migration engine for zapapp.

use rusqlite::{Connection, Transaction};
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("Database error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("Migration error: {0}")]
    Migration(String),

    #[error("Record not found: {0}")]
    NotFound(String),

    #[error("Lock poison error: {0}")]
    Lock(String),

    #[error("Invalid data: {0}")]
    InvalidData(String),
}

/// Represents the status of a chat message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessageStatus {
    Pending,
    Sent,
    Delivered,
    Read,
    Played,
    Failed,
}

impl MessageStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Sent => "sent",
            Self::Delivered => "delivered",
            Self::Read => "read",
            Self::Played => "played",
            Self::Failed => "failed",
        }
    }

    pub fn from_str(s: &str) -> Result<Self, StoreError> {
        match s {
            "pending" => Ok(Self::Pending),
            "sent" => Ok(Self::Sent),
            "delivered" => Ok(Self::Delivered),
            "read" => Ok(Self::Read),
            "played" => Ok(Self::Played),
            "failed" => Ok(Self::Failed),
            other => Err(StoreError::InvalidData(format!("invalid message status: {other}"))),
        }
    }
}

/// Authentication credentials and session tokens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthCredentials {
    pub id: String,
    pub registration_id: u32,
    pub noise_key: Vec<u8>,
    pub identity_key: Vec<u8>,
    pub signed_prekey: Vec<u8>,
    pub signed_prekey_id: u32,
    pub signed_prekey_sig: Vec<u8>,
    pub adv_secret_key: Option<Vec<u8>>,
    pub me_jid: Option<String>,
    pub me_lid: Option<String>,
    pub me_name: Option<String>,
    pub account_sync_counter: u32,
    pub platform: Option<String>,
    pub tokens: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Signal protocol identity keys of contacts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignalIdentity {
    pub address: String,
    pub identity_key: Vec<u8>,
    pub is_trusted: bool,
    pub added_at: i64,
    pub updated_at: i64,
}

/// One-time pre-key records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreKeyRecord {
    pub key_id: u32,
    pub key_pair: Vec<u8>,
    pub public_key: Vec<u8>,
    pub is_uploaded: bool,
    pub is_consumed: bool,
    pub created_at: i64,
}

/// Signal ratchet session records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRecord {
    pub session_id: String,
    pub record: Vec<u8>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Group sender key records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SenderKeyRecord {
    pub group_id: String,
    pub sender_id: String,
    pub record: Vec<u8>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Chat message records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageRecord {
    pub id: String,
    pub chat_jid: String,
    pub sender_jid: String,
    pub from_me: bool,
    pub timestamp: i64,
    pub status: MessageStatus,
    pub message_type: String,
    pub content: Option<String>,
    pub raw_payload: Option<Vec<u8>>,
    pub media_url: Option<String>,
    pub media_mime: Option<String>,
    pub media_size: Option<i64>,
    pub quoted_id: Option<String>,
    pub is_starred: bool,
    pub is_deleted: bool,
}

/// Summary item for recent chat conversations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecentChat {
    pub chat_jid: String,
    pub last_message_id: String,
    pub last_content: Option<String>,
    pub last_timestamp: i64,
    pub unread_count: u32,
}

/// Migration specification.
pub struct Migration {
    pub version: i32,
    pub name: &'static str,
    pub up: &'static str,
}

/// Ordered database migrations.
pub static MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "001_create_auth_credentials",
        up: r#"
        CREATE TABLE IF NOT EXISTS auth_credentials (
            id TEXT PRIMARY KEY,
            registration_id INTEGER NOT NULL,
            noise_key BLOB NOT NULL,
            identity_key BLOB NOT NULL,
            signed_prekey BLOB NOT NULL,
            signed_prekey_id INTEGER NOT NULL,
            signed_prekey_sig BLOB NOT NULL,
            adv_secret_key BLOB,
            me_jid TEXT,
            me_lid TEXT,
            me_name TEXT,
            account_sync_counter INTEGER NOT NULL DEFAULT 0,
            platform TEXT,
            tokens TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        "#,
    },
    Migration {
        version: 2,
        name: "002_create_signal_identities",
        up: r#"
        CREATE TABLE IF NOT EXISTS signal_identities (
            address TEXT PRIMARY KEY,
            identity_key BLOB NOT NULL,
            is_trusted INTEGER NOT NULL DEFAULT 1,
            added_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_signal_identities_updated ON signal_identities(updated_at);
        "#,
    },
    Migration {
        version: 3,
        name: "003_create_pre_keys",
        up: r#"
        CREATE TABLE IF NOT EXISTS pre_keys (
            key_id INTEGER PRIMARY KEY,
            key_pair BLOB NOT NULL,
            public_key BLOB NOT NULL,
            is_uploaded INTEGER NOT NULL DEFAULT 0,
            is_consumed INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pre_keys_consumed ON pre_keys(is_consumed);
        CREATE INDEX IF NOT EXISTS idx_pre_keys_uploaded ON pre_keys(is_uploaded);
        "#,
    },
    Migration {
        version: 4,
        name: "004_create_session_records",
        up: r#"
        CREATE TABLE IF NOT EXISTS session_records (
            session_id TEXT PRIMARY KEY,
            record BLOB NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_session_records_updated ON session_records(updated_at);
        "#,
    },
    Migration {
        version: 5,
        name: "005_create_sender_keys",
        up: r#"
        CREATE TABLE IF NOT EXISTS sender_keys (
            group_id TEXT NOT NULL,
            sender_id TEXT NOT NULL,
            record BLOB NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (group_id, sender_id)
        );
        CREATE INDEX IF NOT EXISTS idx_sender_keys_group ON sender_keys(group_id);
        "#,
    },
    Migration {
        version: 6,
        name: "006_create_messages",
        up: r#"
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            chat_jid TEXT NOT NULL,
            sender_jid TEXT NOT NULL,
            from_me INTEGER NOT NULL,
            timestamp INTEGER NOT NULL,
            status TEXT NOT NULL,
            message_type TEXT NOT NULL,
            content TEXT,
            raw_payload BLOB,
            media_url TEXT,
            media_mime TEXT,
            media_size INTEGER,
            quoted_id TEXT,
            is_starred INTEGER NOT NULL DEFAULT 0,
            is_deleted INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_jid, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_jid);
        CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
        CREATE INDEX IF NOT EXISTS idx_messages_from_me ON messages(from_me);
        "#,
    },
];

/// Applies pending migrations sequentially within transactions.
pub fn run_migrations(conn: &mut Connection) -> Result<(), StoreError> {
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );
        "#,
    )?;

    let current_version: i32 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;

    for migration in MIGRATIONS {
        if migration.version > current_version {
            let tx = conn.transaction()?;
            apply_migration(&tx, migration)?;
            tx.commit()?;
        }
    }

    Ok(())
}

fn apply_migration(tx: &Transaction, migration: &Migration) -> Result<(), StoreError> {
    tx.execute_batch(migration.up)?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    tx.execute(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![migration.version, migration.name, now],
    )?;

    Ok(())
}
