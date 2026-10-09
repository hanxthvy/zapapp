// [xihanzu-NR]
//! Local SQLite storage engine for zapapp.
//! Provides persistent storage for session tokens, crypto keys, and chat history.

pub mod db;
pub mod schema;

pub use db::*;
pub use schema::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_migrations_and_auth_credentials() {
        let db = Database::open_in_memory().expect("open in-memory db");

        let creds = AuthCredentials {
            id: "default_session".to_string(),
            registration_id: 12345,
            noise_key: vec![1, 2, 3, 4],
            identity_key: vec![5, 6, 7, 8],
            signed_prekey: vec![9, 10, 11, 12],
            signed_prekey_id: 1,
            signed_prekey_sig: vec![13, 14, 15, 16],
            adv_secret_key: Some(vec![17, 18]),
            me_jid: Some("628123456789@s.whatsapp.net".to_string()),
            me_lid: Some("123456789@lid".to_string()),
            me_name: Some("ZapApp User".to_string()),
            account_sync_counter: 0,
            platform: Some("android".to_string()),
            tokens: Some(r#"{"client_token":"xyz"}"#.to_string()),
            created_at: 1000,
            updated_at: 1000,
        };

        db.save_auth_credentials(&creds).expect("save credentials");

        let retrieved = db
            .get_auth_credentials("default_session")
            .expect("get credentials")
            .expect("should exist");
        assert_eq!(retrieved.registration_id, 12345);
        assert_eq!(retrieved.me_name.as_deref(), Some("ZapApp User"));

        // Update token
        db.save_session_token("default_session", r#"{"updated_token":"abc"}"#)
            .expect("save session token");
        let token = db
            .get_session_token("default_session")
            .expect("get session token")
            .expect("token exists");
        assert_eq!(token, r#"{"updated_token":"abc"}"#);

        // List
        let list = db.list_auth_credentials().expect("list credentials");
        assert_eq!(list.len(), 1);

        // Delete
        let deleted = db
            .delete_auth_credentials("default_session")
            .expect("delete credentials");
        assert!(deleted);
        let missing = db
            .get_auth_credentials("default_session")
            .expect("get credentials");
        assert!(missing.is_none());
    }

    #[test]
    fn test_signal_identities_and_keys() {
        let db = Database::open_in_memory().expect("open in-memory db");

        // Identity
        let id_key = vec![0xaa, 0xbb, 0xcc];
        let identity = SignalIdentity {
            address: "user@s.whatsapp.net".to_string(),
            identity_key: id_key.clone(),
            is_trusted: true,
            added_at: 100,
            updated_at: 100,
        };
        db.save_identity(&identity).expect("save identity");

        let retrieved_id = db
            .get_identity("user@s.whatsapp.net")
            .expect("get identity")
            .expect("exists");
        assert_eq!(retrieved_id.identity_key, id_key);
        assert!(db
            .is_trusted_identity("user@s.whatsapp.net", &id_key)
            .expect("trusted check"));
        assert!(!db
            .is_trusted_identity("user@s.whatsapp.net", &[0x00])
            .expect("trusted check mismatch"));

        // Pre-keys
        let pre_keys = vec![
            PreKeyRecord {
                key_id: 1,
                key_pair: vec![1, 2],
                public_key: vec![2],
                is_uploaded: true,
                is_consumed: false,
                created_at: 200,
            },
            PreKeyRecord {
                key_id: 2,
                key_pair: vec![3, 4],
                public_key: vec![4],
                is_uploaded: true,
                is_consumed: false,
                created_at: 200,
            },
        ];
        db.save_pre_keys_batch(&pre_keys).expect("batch pre-keys");
        assert_eq!(db.count_available_pre_keys().expect("count"), 2);

        db.mark_pre_key_consumed(1).expect("mark consumed");
        assert_eq!(db.count_available_pre_keys().expect("count"), 1);
        let avail = db.get_available_pre_keys(10).expect("get available");
        assert_eq!(avail.len(), 1);
        assert_eq!(avail[0].key_id, 2);

        // Session record
        let session = SessionRecord {
            session_id: "user@s.whatsapp.net:1".to_string(),
            record: vec![10, 20, 30],
            created_at: 300,
            updated_at: 300,
        };
        db.save_session(&session).expect("save session");
        assert!(db.has_session("user@s.whatsapp.net:1").expect("has session"));
        let got_sess = db
            .get_session("user@s.whatsapp.net:1")
            .expect("get session")
            .expect("exists");
        assert_eq!(got_sess.record, vec![10, 20, 30]);

        // Sender key
        let sender_key = SenderKeyRecord {
            group_id: "12345@g.us".to_string(),
            sender_id: "alice@s.whatsapp.net".to_string(),
            record: vec![99, 88],
            created_at: 400,
            updated_at: 400,
        };
        db.save_sender_key(&sender_key).expect("save sender key");
        let got_sk = db
            .get_sender_key("12345@g.us", "alice@s.whatsapp.net")
            .expect("get sender key")
            .expect("exists");
        assert_eq!(got_sk.record, vec![99, 88]);
        assert_eq!(
            db.delete_group_sender_keys("12345@g.us")
                .expect("delete group"),
            1
        );
    }

    #[test]
    fn test_chat_messages_crud() {
        let db = Database::open_in_memory().expect("open in-memory db");

        let msg1 = MessageRecord {
            id: "msg_001".to_string(),
            chat_jid: "chat_a@s.whatsapp.net".to_string(),
            sender_jid: "chat_a@s.whatsapp.net".to_string(),
            from_me: false,
            timestamp: 1000,
            status: MessageStatus::Delivered,
            message_type: "text".to_string(),
            content: Some("Hello from peer".to_string()),
            raw_payload: None,
            media_url: None,
            media_mime: None,
            media_size: None,
            quoted_id: None,
            is_starred: false,
            is_deleted: false,
        };

        let msg2 = MessageRecord {
            id: "msg_002".to_string(),
            chat_jid: "chat_a@s.whatsapp.net".to_string(),
            sender_jid: "me@s.whatsapp.net".to_string(),
            from_me: true,
            timestamp: 1010,
            status: MessageStatus::Sent,
            message_type: "text".to_string(),
            content: Some("Replying back".to_string()),
            raw_payload: None,
            media_url: None,
            media_mime: None,
            media_size: None,
            quoted_id: Some("msg_001".to_string()),
            is_starred: true,
            is_deleted: false,
        };

        db.insert_message(&msg1).expect("insert msg1");
        db.insert_message(&msg2).expect("insert msg2");

        // Get single message
        let got1 = db.get_message("msg_001").expect("get msg").expect("exists");
        assert_eq!(got1.content.as_deref(), Some("Hello from peer"));
        assert!(!got1.from_me);

        // Update status
        db.update_message_status("msg_002", MessageStatus::Read)
            .expect("update status");
        let got2 = db.get_message("msg_002").expect("get msg").expect("exists");
        assert_eq!(got2.status, MessageStatus::Read);

        // Paginated chat messages
        let chat_msgs = db
            .get_chat_messages("chat_a@s.whatsapp.net", 10, 0)
            .expect("get chat messages");
        assert_eq!(chat_msgs.len(), 2);
        assert_eq!(chat_msgs[0].id, "msg_002"); // timestamp 1010 first

        // Unread count
        assert_eq!(
            db.get_unread_count("chat_a@s.whatsapp.net")
                .expect("unread count"),
            1
        );

        // Mark as read
        let marked = db
            .mark_chat_as_read("chat_a@s.whatsapp.net")
            .expect("mark read");
        assert_eq!(marked, 1);
        assert_eq!(
            db.get_unread_count("chat_a@s.whatsapp.net")
                .expect("unread count"),
            0
        );

        // Search
        let search_res = db.search_messages("Replying", 10).expect("search");
        assert_eq!(search_res.len(), 1);
        assert_eq!(search_res[0].id, "msg_002");

        // Recent chats
        let recents = db.get_recent_chats(10).expect("recent chats");
        assert_eq!(recents.len(), 1);
        assert_eq!(recents[0].chat_jid, "chat_a@s.whatsapp.net");
        assert_eq!(recents[0].last_message_id, "msg_002");

        // Soft delete
        db.delete_message("msg_001", true).expect("soft delete");
        let deleted_msg = db.get_message("msg_001").expect("get").expect("exists");
        assert!(deleted_msg.is_deleted);
        assert_eq!(
            db.count_messages_in_chat("chat_a@s.whatsapp.net")
                .expect("count active"),
            1
        );
    }
}
