<!-- [xihanzu-NR] -->
# ZapApp — High-Performance WhatsApp Client for Android (Rust Native Core + WebView)

**ZapApp** is a high-performance, battery-efficient Android WhatsApp Web client built using a native Rust engine (`libzapapp_core.so`) compiled via Android NDK and exposed through JNI, wrapped in an Android Foreground Service and a modern WhatsApp dark-themed SPA (Acode-style).

---

## ⚡ Key Highlights

- **Rust Native Protocol & Crypto Core**:
  - `Noise_XX_25519_AESGCM_SHA256` handshake state machine.
  - Curve25519 ECDH agreement & Ed25519 signatures.
  - AES-256-GCM authenticated encryption/decryption.
  - SQLite WAL persistent store for Signal keys, prekeys, sessions, and chat history.
  - Async Tokio network runtime (`wss://web.whatsapp.com/ws/chat`).
- **Interactive Buttons Support (Bypass Meta Restriction)**:
  - Supports Native Flow Buttons: Quick Reply, CTA URL, CTA Copy.
  - Automatically wraps buttons inside `viewOnceMessage` to bypass Meta's client-side personal account button blocks.
  - Interactive Button Composer directly inside chat view.
- **Android 14/15/17 + Play Protect Ready**:
  - Strict 16 KB page-size alignment (`zipalign -P 16`) for next-gen Android kernels.
  - Persistent Android `ForegroundService` with `dataSync` type, Partial `WakeLock`, and Network Change Receiver to prevent Android Doze and OOM Killer terminations.
  - Signed with 4096-bit RSA keystore (APK Signature Scheme v2 & v3).

---

## 📁 Project Structure

```
zapapp/
├── core/                       # Rust Native Core (cdylib + rlib)
│   ├── src/
│   │   ├── auth/               # Companion device QR and pairing code logic
│   │   ├── crypto/             # Curve25519, Ed25519, AES-GCM, Noise Handshake
│   │   ├── message/            # Interactive Native Flow buttons & viewOnce wrapper
│   │   ├── network/            # Tokio WebSocket stream & stanza dispatcher
│   │   ├── proto/              # Binary XML tokens & stanza encoder
│   │   ├── store/              # Rusqlite database schema & CRUD operations
│   │   └── lib.rs              # JNI export bindings
│   └── tests/                  # Rust test suites (crypto, buttons, golden tests)
├── android/                    # Android Host Application
│   └── app/src/main/
│       ├── AndroidManifest.xml # Permissions (FOREGROUND_SERVICE, WAKE_LOCK, etc.)
│       ├── java/com/hxdev/zapapp/
│       │   ├── MainActivity.java        # WebView edge-to-edge host
│       │   ├── NativeZapCore.java       # JNI declarations & event callbacks
│       │   ├── WebBridge.java           # JavaScriptInterface bridge
│       │   ├── ZapForegroundService.java# Sticky foreground service (Anti-Doze)
│       │   └── BootReceiver.java        # Auto-restart on reboot
│       └── jniLibs/            # Pre-compiled .so binaries (arm64-v8a, x86_64)
├── ui/                         # Acode-style Lightweight Mobile SPA
│   ├── index.html              # Main dashboard (Chats, Status, Calls, Settings)
│   ├── css/                    # WhatsApp dark theme palette
│   └── js/                     # Client logic (app.js, chat.js, auth.js)
└── scripts/
    └── build-apk.sh            # Automated compilation & packaging script
```

---

## 🛠️ Build & Verification

```bash
# 1. Run Rust Core tests (78 tests)
cargo test --manifest-path core/Cargo.toml

# 2. Run UI tests
node ui/test_auth.js
node ui/test_chat.js

# 3. Build APK for Android
./scripts/build-apk.sh --release
```

---

## 🔒 Attribution & License

Proprietary engineering and research by HxDev.
<!-- [xihanzu-NR] -->
