// [xihanzu-NR]

pub mod auth;
pub mod crypto;
pub mod message;
pub mod network;
pub mod proto;
pub mod store;

use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use jni::JNIEnv;
use jni::objects::{JClass, JString};
use jni::sys::{jboolean, jstring, JNI_FALSE, JNI_TRUE};
use rand::Rng;

use crate::crypto::noise::HandshakeState;
use crate::message::builder::InteractiveMessageBuilder;
use crate::message::buttons::{Button, NativeFlowButton};
use crate::network::client::NetworkClientHandle;
use crate::network::stream::{DefaultWhatsAppStream, WhatsAppStream, WA_WS_URL};
use crate::network::{NetworkClient, NetworkConfig};
use crate::proto::stanza::{wrap_proto_message_stanza, ProtoWireWriter};
use crate::store::schema::{AuthCredentials, MessageRecord, MessageStatus};
use crate::store::Database;

/// Active runtime state for ZapApp core engine.
pub struct ZapCoreState {
    pub db: Arc<Database>,
    pub client: Option<NetworkClientHandle>,
    pub session_id: String,
    pub me_jid: Option<String>,
}

static CORE_RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
static CORE_STATE: Mutex<Option<ZapCoreState>> = Mutex::new(None);

/// Returns the shared Tokio multi-threaded asynchronous runtime.
pub fn get_runtime() -> &'static tokio::runtime::Runtime {
    CORE_RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("Failed to initialize ZapApp Tokio runtime")
    })
}

/// Reset core state (primarily for tests).
pub fn core_reset() {
    if let Ok(mut lock) = CORE_STATE.lock() {
        if let Some(mut state) = lock.take() {
            if let Some(client) = state.client.take() {
                let rt = get_runtime();
                let _ = rt.block_on(client.disconnect());
            }
        }
    }
}

/// Initialize ZapApp engine with local SQLite database storage.
pub fn core_init(db_path: &str) -> Result<(), String> {
    let db = if db_path.is_empty() || db_path == ":memory:" {
        Database::open_in_memory().map_err(|e| format!("Failed to open in-memory db: {e}"))?
    } else {
        if let Some(parent) = Path::new(db_path).parent() {
            if !parent.as_os_str().is_empty() {
                let _ = std::fs::create_dir_all(parent);
            }
        }
        Database::open(db_path).map_err(|e| format!("Failed to open db at {db_path}: {e}"))?
    };

    let me_jid = db
        .get_auth_credentials("default_session")
        .ok()
        .flatten()
        .and_then(|c| c.me_jid);

    let _ = get_runtime();

    let mut lock = CORE_STATE.lock().map_err(|e| e.to_string())?;
    *lock = Some(ZapCoreState {
        db: Arc::new(db),
        client: None,
        session_id: "default_session".to_string(),
        me_jid,
    });

    Ok(())
}

/// Connect to WhatsApp WebSocket gateway.
pub fn core_connect(server_url: &str, session_json: &str) -> Result<(), String> {
    let rt = get_runtime();

    // Ensure database is initialized
    {
        let mut state_guard = CORE_STATE.lock().map_err(|e| e.to_string())?;
        if state_guard.is_none() {
            let db = Database::open_in_memory().map_err(|e| format!("Auto-init db error: {e}"))?;
            *state_guard = Some(ZapCoreState {
                db: Arc::new(db),
                client: None,
                session_id: "default_session".to_string(),
                me_jid: None,
            });
        }
    }

    // Save session credentials if provided
    if !session_json.trim().is_empty() {
        if let Ok(creds) = serde_json::from_str::<AuthCredentials>(session_json) {
            let mut state_guard = CORE_STATE.lock().map_err(|e| e.to_string())?;
            if let Some(ref mut state) = *state_guard {
                state.me_jid = creds.me_jid.clone();
                let _ = state.db.save_auth_credentials(&creds);
            }
        }
    }

    let url = if server_url.trim().is_empty() {
        WA_WS_URL
    } else {
        server_url
    };

    if url.starts_with("mock://") || url.starts_with("test://") {
        let (client_io, server_io) = tokio::io::duplex(65536);
        let client_e = crate::crypto::curve::generate_key_pair();
        let client_handshake = HandshakeState::new(client_e, None, None);

        rt.spawn(async move {
            use futures_util::StreamExt;
            use tokio_tungstenite::tungstenite::protocol::Role;
            use tokio_tungstenite::WebSocketStream;
            let mut server_ws =
                WebSocketStream::from_raw_socket(server_io, Role::Server, None).await;
            while let Some(_) = server_ws.next().await {}
        });

        let handle = rt.block_on(async {
            use tokio_tungstenite::tungstenite::protocol::Role;
            use tokio_tungstenite::WebSocketStream;
            let client_ws =
                WebSocketStream::from_raw_socket(client_io, Role::Client, None).await;
            let stream = WhatsAppStream::from_raw_ws(client_ws, client_handshake);
            let config = NetworkConfig::default();
            let (h, _) = NetworkClient::start(stream, config);
            h
        });

        let mut state_guard = CORE_STATE.lock().map_err(|e| e.to_string())?;
        if let Some(ref mut state) = *state_guard {
            state.client = Some(handle);
        }
        return Ok(());
    }

    // Live connection attempt
    let config = NetworkConfig {
        ws_url: url.to_string(),
        connect_timeout: Duration::from_secs(10),
        ..Default::default()
    };

    let client_e = crate::crypto::curve::generate_key_pair();
    let res = rt.block_on(async {
        let stream = DefaultWhatsAppStream::connect(&config, client_e, None, None)
            .await
            .map_err(|e| format!("Connect failed: {e}"))?;

        let (handle, _) = NetworkClient::start(stream, config);
        Ok::<_, String>(handle)
    });

    match res {
        Ok(handle) => {
            let mut state_guard = CORE_STATE.lock().map_err(|e| e.to_string())?;
            if let Some(ref mut state) = *state_guard {
                state.client = Some(handle);
            }
            Ok(())
        }
        Err(e) => Err(e),
    }
}

/// Send plain text message and store in local database.
pub fn core_send_message(to: &str, text: &str) -> Result<String, String> {
    if to.trim().is_empty() {
        return Err("Recipient JID cannot be empty".to_string());
    }
    if text.trim().is_empty() {
        return Err("Message text cannot be empty".to_string());
    }

    let mut state_guard = CORE_STATE.lock().map_err(|e| e.to_string())?;
    if state_guard.is_none() {
        let db = Database::open_in_memory().map_err(|e| format!("Auto-init db error: {e}"))?;
        *state_guard = Some(ZapCoreState {
            db: Arc::new(db),
            client: None,
            session_id: "default_session".to_string(),
            me_jid: None,
        });
    }

    let state = state_guard.as_mut().unwrap();

    let mut random_bytes = [0u8; 8];
    rand::rng().fill_bytes(&mut random_bytes);
    let msg_id = format!("3EB0{}", hex::encode(random_bytes).to_uppercase());

    // Encode text as Protobuf conversation field (field 1)
    let mut writer = ProtoWireWriter::new();
    writer.write_string_field(1, text);
    let proto_bytes = writer.into_bytes();

    let stanza_node = wrap_proto_message_stanza(&msg_id, to, proto_bytes.clone(), "text", None);

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let my_jid = state
        .me_jid
        .clone()
        .unwrap_or_else(|| "me@s.whatsapp.net".to_string());

    let record = MessageRecord {
        id: msg_id.clone(),
        chat_jid: to.to_string(),
        sender_jid: my_jid,
        from_me: true,
        timestamp: now,
        status: MessageStatus::Sent,
        message_type: "text".to_string(),
        content: Some(text.to_string()),
        raw_payload: Some(proto_bytes),
        media_url: None,
        media_mime: None,
        media_size: None,
        quoted_id: None,
        is_starred: false,
        is_deleted: false,
    };

    let _ = state.db.insert_message(&record);

    if let Some(ref client) = state.client {
        let rt = get_runtime();
        let _ = rt.block_on(client.send_node(stanza_node));
    }

    Ok(msg_id)
}

/// Send interactive button message with ViewOnce wrapper and store in local database.
pub fn core_send_button_message(to: &str, text: &str, buttons_json: &str) -> Result<String, String> {
    if to.trim().is_empty() {
        return Err("Recipient JID cannot be empty".to_string());
    }

    let mut state_guard = CORE_STATE.lock().map_err(|e| e.to_string())?;
    if state_guard.is_none() {
        let db = Database::open_in_memory().map_err(|e| format!("Auto-init db error: {e}"))?;
        *state_guard = Some(ZapCoreState {
            db: Arc::new(db),
            client: None,
            session_id: "default_session".to_string(),
            me_jid: None,
        });
    }

    let state = state_guard.as_mut().unwrap();

    let buttons: Vec<Button> = if buttons_json.trim().is_empty() {
        vec![Button::quick_reply("OK", "btn_ok")]
    } else if let Ok(parsed) = serde_json::from_str::<Vec<Button>>(buttons_json) {
        if parsed.is_empty() {
            vec![Button::quick_reply("OK", "btn_ok")]
        } else {
            parsed
        }
    } else if let Ok(nfb_list) = serde_json::from_str::<Vec<NativeFlowButton>>(buttons_json) {
        let mut list = Vec::new();
        for nfb in nfb_list {
            match nfb.name.as_str() {
                "quick_reply" => list.push(Button::quick_reply("Reply", "reply")),
                "cta_url" => list.push(Button::cta_url("Open Link", "https://whatsapp.com")),
                "cta_copy" => list.push(Button::copy("Copy Code", "CODE123")),
                _ => list.push(Button::quick_reply("Option", "opt")),
            }
        }
        if list.is_empty() {
            vec![Button::quick_reply("OK", "btn_ok")]
        } else {
            list
        }
    } else {
        vec![Button::quick_reply(buttons_json.trim(), "btn_action")]
    };

    let mut random_bytes = [0u8; 8];
    rand::rng().fill_bytes(&mut random_bytes);
    let msg_id = format!("3EB0{}", hex::encode(random_bytes).to_uppercase());

    let mut builder = InteractiveMessageBuilder::new()
        .body(text)
        .view_once(true);

    for btn in buttons {
        builder = builder.add_button(btn);
    }

    let proto_bytes = builder.build_message_proto_bytes();
    let stanza_node = builder.build_message_stanza(&msg_id, to, "text", proto_bytes.clone());

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let my_jid = state
        .me_jid
        .clone()
        .unwrap_or_else(|| "me@s.whatsapp.net".to_string());

    let record = MessageRecord {
        id: msg_id.clone(),
        chat_jid: to.to_string(),
        sender_jid: my_jid,
        from_me: true,
        timestamp: now,
        status: MessageStatus::Sent,
        message_type: "interactive".to_string(),
        content: Some(text.to_string()),
        raw_payload: Some(proto_bytes),
        media_url: None,
        media_mime: None,
        media_size: None,
        quoted_id: None,
        is_starred: false,
        is_deleted: false,
    };

    let _ = state.db.insert_message(&record);

    if let Some(ref client) = state.client {
        let rt = get_runtime();
        let _ = rt.block_on(client.send_node(stanza_node));
    }

    Ok(msg_id)
}

/// Disconnect the active network session.
pub fn core_disconnect() -> Result<(), String> {
    let mut state_guard = CORE_STATE.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut state) = *state_guard {
        if let Some(client) = state.client.take() {
            let rt = get_runtime();
            let _ = rt.block_on(client.disconnect());
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// JNI Exported Functions (Java_com_hxdev_zapapp_NativeZapCore_*)
// ---------------------------------------------------------------------------

/// JNI Export: Initialize NativeZapCore engine with SQLite database path.
/// Signature: (Ljava/lang/String;)Z
#[no_mangle]
pub extern "system" fn Java_com_hxdev_zapapp_NativeZapCore_init<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    db_path: JString<'local>,
) -> jboolean {
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let path = if db_path.is_null() {
            String::new()
        } else {
            match env.get_string(&db_path) {
                Ok(s) => s.into(),
                Err(_) => return JNI_FALSE,
            }
        };

        match core_init(&path) {
            Ok(_) => JNI_TRUE,
            Err(e) => {
                eprintln!("[NativeZapCore] init failed: {e}");
                JNI_FALSE
            }
        }
    }));

    res.unwrap_or(JNI_FALSE)
}

/// JNI Export: Connect to WhatsApp WebSocket gateway.
/// Signature: (Ljava/lang/String;Ljava/lang/String;)Z
#[no_mangle]
pub extern "system" fn Java_com_hxdev_zapapp_NativeZapCore_connect<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    server_url: JString<'local>,
    session_json: JString<'local>,
) -> jboolean {
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let url = if server_url.is_null() {
            String::new()
        } else {
            match env.get_string(&server_url) {
                Ok(s) => s.into(),
                Err(_) => String::new(),
            }
        };

        let session = if session_json.is_null() {
            String::new()
        } else {
            match env.get_string(&session_json) {
                Ok(s) => s.into(),
                Err(_) => String::new(),
            }
        };

        match core_connect(&url, &session) {
            Ok(_) => JNI_TRUE,
            Err(e) => {
                eprintln!("[NativeZapCore] connect failed: {e}");
                JNI_FALSE
            }
        }
    }));

    res.unwrap_or(JNI_FALSE)
}

/// JNI Export: Send plain text message.
/// Signature: (Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;
#[no_mangle]
pub extern "system" fn Java_com_hxdev_zapapp_NativeZapCore_sendMessage<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    to: JString<'local>,
    text: JString<'local>,
) -> jstring {
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if to.is_null() || text.is_null() {
            return std::ptr::null_mut();
        }

        let to_str: String = match env.get_string(&to) {
            Ok(s) => s.into(),
            Err(_) => return std::ptr::null_mut(),
        };

        let text_str: String = match env.get_string(&text) {
            Ok(s) => s.into(),
            Err(_) => return std::ptr::null_mut(),
        };

        match core_send_message(&to_str, &text_str) {
            Ok(msg_id) => match env.new_string(msg_id) {
                Ok(jstr) => jstr.into_raw(),
                Err(_) => std::ptr::null_mut(),
            },
            Err(e) => {
                eprintln!("[NativeZapCore] sendMessage failed: {e}");
                std::ptr::null_mut()
            }
        }
    }));

    res.unwrap_or(std::ptr::null_mut())
}

/// JNI Export: Send interactive button message.
/// Signature: (Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;
#[no_mangle]
pub extern "system" fn Java_com_hxdev_zapapp_NativeZapCore_sendButtonMessage<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    to: JString<'local>,
    text: JString<'local>,
    buttons_json: JString<'local>,
) -> jstring {
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if to.is_null() {
            return std::ptr::null_mut();
        }

        let to_str: String = match env.get_string(&to) {
            Ok(s) => s.into(),
            Err(_) => return std::ptr::null_mut(),
        };

        let text_str: String = if text.is_null() {
            String::new()
        } else {
            match env.get_string(&text) {
                Ok(s) => s.into(),
                Err(_) => String::new(),
            }
        };

        let btns_str: String = if buttons_json.is_null() {
            String::new()
        } else {
            match env.get_string(&buttons_json) {
                Ok(s) => s.into(),
                Err(_) => String::new(),
            }
        };

        match core_send_button_message(&to_str, &text_str, &btns_str) {
            Ok(msg_id) => match env.new_string(msg_id) {
                Ok(jstr) => jstr.into_raw(),
                Err(_) => std::ptr::null_mut(),
            },
            Err(e) => {
                eprintln!("[NativeZapCore] sendButtonMessage failed: {e}");
                std::ptr::null_mut()
            }
        }
    }));

    res.unwrap_or(std::ptr::null_mut())
}

/// JNI Export: Disconnect active network session.
/// Signature: ()Z
#[no_mangle]
pub extern "system" fn Java_com_hxdev_zapapp_NativeZapCore_disconnect<'local>(
    _env: JNIEnv<'local>,
    _class: JClass<'local>,
) -> jboolean {
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match core_disconnect() {
            Ok(_) => JNI_TRUE,
            Err(e) => {
                eprintln!("[NativeZapCore] disconnect failed: {e}");
                JNI_FALSE
            }
        }
    }));

    res.unwrap_or(JNI_FALSE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_core_lifecycle_and_messaging() {
        core_reset();

        // 1. Init in-memory
        assert!(core_init(":memory:").is_ok());

        // 2. Connect via mock stream
        assert!(core_connect("mock://", "").is_ok());

        // 3. Send plain text message
        let text_res = core_send_message("628123456789@s.whatsapp.net", "Hello from ZapApp JNI!");
        assert!(text_res.is_ok());
        let text_id = text_res.unwrap();
        assert!(text_id.starts_with("3EB0"));

        // 4. Send button message (Quick Reply + CTA URL + CTA Copy)
        let buttons = serde_json::json!([
            { "type": "quick_reply", "display_text": "Confirm", "id": "btn_confirm" },
            { "type": "cta_url", "display_text": "Visit Website", "url": "https://whatsapp.com" },
            { "type": "cta_copy", "display_text": "Copy Promo", "copy_code": "ZAP2026" }
        ])
        .to_string();

        let btn_res = core_send_button_message(
            "628123456789@s.whatsapp.net",
            "Interactive buttons message",
            &buttons,
        );
        assert!(btn_res.is_ok());
        let btn_id = btn_res.unwrap();
        assert!(btn_id.starts_with("3EB0"));

        // Verify stored in SQLite
        {
            let lock = CORE_STATE.lock().unwrap();
            let state = lock.as_ref().unwrap();
            let msg1 = state.db.get_message(&text_id).unwrap().unwrap();
            assert_eq!(msg1.content.as_deref(), Some("Hello from ZapApp JNI!"));
            assert_eq!(msg1.message_type, "text");

            let msg2 = state.db.get_message(&btn_id).unwrap().unwrap();
            assert_eq!(msg2.content.as_deref(), Some("Interactive buttons message"));
            assert_eq!(msg2.message_type, "interactive");
        }

        // 5. Disconnect
        assert!(core_disconnect().is_ok());
        core_reset();
    }
}
