// [xihanzu-NR]
'use strict';

/**
 * Node.js Mobile entry point for ZapApp on Android.
 * Embeds zapo-js WhatsApp client engine with SQLite WAL persistence.
 *
 * Capabilities:
 * - Bundled/imported zapo-js runtime integration.
 * - SQLite storage persistence pointing to NODEJS_STORAGE_PATH or app storage.
 * - Bi-directional Android Bridge IPC:
 *   * Events emitted: 'auth_qr', 'auth_pairing_code', 'auth_paired', 'message', 'connection'
 *   * Commands accepted: 'send_message', 'send_button_message', 'request_pairing_code', 'disconnect'
 * - Multi-transport IPC listener: rn-bridge, process IPC, stdio stream, and localhost TCP server.
 */

const path = require('path');

const {
  createPersistenceStore,
  createSqliteStore,
  resolveFilesDir,
  getSessionDbPath,
  getWalDbPath
} = require('./store');

const {
  handleSendButtonMessage: handleSendButtonFlow,
  setupButtonFlow
} = require('./button-flow');

const {
  IpcBridge,
  createIpcBridge,
  serializeEvent,
  serializeResponse,
  serializeCommand,
  createLineDecoder
} = require('./ipc');

// Bridge event emitter & transport coordinator for Android host
const ipcBridge = createIpcBridge();
const bridgeEmitter = ipcBridge;

// -----------------------------------------------------------------------------
// 1. zapo-js Runtime Loader
// -----------------------------------------------------------------------------

function resolveZapo() {
  const loaders = [
    () => require('./zapo-bundle'),
    () => require('/tmp/zapo'),
    () => require('zapo-js')
  ];

  for (const load of loaders) {
    try {
      const pkg = load();
      if (pkg && pkg.WaClient && pkg.createStore) {
        return pkg;
      }
    } catch (_) {}
  }

  throw new Error('Could not resolve zapo-js library from bundle, /tmp/zapo, or module paths.');
}

const zapo = resolveZapo();
const { WaClient, createStore, proto, unwrapMessage, getContentType } = zapo;

// -----------------------------------------------------------------------------
// 2. Global Runtime State
// -----------------------------------------------------------------------------

let waClient = null;
let persistenceStore = null;
let pairingFlowHandler = null;
let isInitializing = false;

// -----------------------------------------------------------------------------
// 3. Serialization Helpers
// -----------------------------------------------------------------------------

function serializeBytes(value) {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return Buffer.from(value).toString('base64');
  }
  if (Array.isArray(value)) {
    return value.map(serializeBytes);
  }
  if (value && typeof value === 'object') {
    const obj = {};
    for (const [k, v] of Object.entries(value)) {
      obj[k] = serializeBytes(v);
    }
    return obj;
  }
  return value;
}

function extractMessageText(message) {
  if (!message) return '';
  const unwrapped = unwrapMessage ? unwrapMessage(message) : message;

  if (typeof unwrapped.conversation === 'string') {
    return unwrapped.conversation;
  }
  if (unwrapped.extendedTextMessage && unwrapped.extendedTextMessage.text) {
    return unwrapped.extendedTextMessage.text;
  }
  if (unwrapped.interactiveMessage && unwrapped.interactiveMessage.body) {
    return unwrapped.interactiveMessage.body.text || '';
  }
  if (unwrapped.imageMessage && unwrapped.imageMessage.caption) {
    return unwrapped.imageMessage.caption;
  }
  if (unwrapped.videoMessage && unwrapped.videoMessage.caption) {
    return unwrapped.videoMessage.caption;
  }
  return '';
}

function formatIncomingMessage(evt) {
  const key = evt.key || {};
  const rawMsg = evt.message || {};
  const text = extractMessageText(rawMsg);
  const chatId = key.remoteJid || evt.chatJid || '';
  const msgId = key.id || `msg_${Date.now()}`;
  const timestamp = evt.timestampSeconds ? (evt.timestampSeconds * 1000) : Date.now();
  const fromMe = Boolean(key.fromMe);
  const senderJid = key.participant || (fromMe ? (waClient?.auth?.credentials?.meJid || 'me') : chatId);

  return {
    id: msgId,
    chatId: chatId,
    remoteJid: chatId,
    senderJid: senderJid,
    participant: key.participant,
    fromMe: fromMe,
    text: text,
    content: text,
    type: getContentType ? getContentType(rawMsg) : (text ? 'text' : 'unknown'),
    pushName: evt.pushName || '',
    timestamp: timestamp,
    message: rawMsg
  };
}

// -----------------------------------------------------------------------------
// 4. Android Bridge Event Dispatcher
// -----------------------------------------------------------------------------

function emitToBridge(event, data) {
  return ipcBridge.sendEvent(event, data);
}

// -----------------------------------------------------------------------------
// 5. IPC Command Handlers
// -----------------------------------------------------------------------------

async function handleSendMessage(args) {
  if (!waClient) throw new Error('WaClient is not initialized');
  const to = args.to || args.chatId || args.recipient || args.jid;
  if (!to) throw new Error('Missing recipient JID');

  const text = args.text || args.content || args.body || '';
  const options = {};
  const quoteId = args.replyToId || args.quotedId;
  if (quoteId) {
    options.quote = {
      key: {
        remoteJid: to,
        id: quoteId,
        fromMe: false
      }
    };
  }

  const result = await waClient.message.send(to, text, options);
  const msgId = result?.id || args.id || `msg_${Date.now()}`;
  return {
    status: 'ok',
    id: msgId,
    to: to,
    chatId: to
  };
}

async function handleSendButtonMessage(args) {
  if (!waClient) throw new Error('WaClient is not initialized');
  return await handleSendButtonFlow(waClient, args);
}

async function handleRequestPairingCode(args) {
  if (!waClient) throw new Error('WaClient is not initialized');

  if (pairingFlowHandler && typeof pairingFlowHandler.requestPairingCode === 'function') {
    const res = await pairingFlowHandler.requestPairingCode(args);
    return {
      status: 'ok',
      code: res.code,
      phoneNumber: res.phoneNumber
    };
  }

  const phone = args.phoneNumber || args.phone || args.number || (typeof args === 'string' ? args : '');
  if (!phone || typeof phone !== 'string') {
    throw new Error('Valid phone number string required for pairing code');
  }

  const sanitizedPhone = phone.replace(/[^0-9]/g, '');
  if (!sanitizedPhone) {
    throw new Error('Sanitized phone number is empty');
  }

  const code = await waClient.auth.requestPairingCode(sanitizedPhone);
  const formattedCode = String(code).length === 8 ? `${String(code).slice(0, 4)}-${String(code).slice(4)}` : code;

  emitToBridge('auth_pairing_code', {
    code: code,
    ttl: 180,
    ttlMs: 180000
  });

  emitToBridge('pairing_code_live', {
    code: code,
    formattedCode: formattedCode,
    phoneNumber: sanitizedPhone,
    ttl: 180,
    ttlMs: 180000
  });

  return {
    status: 'ok',
    code: code,
    phoneNumber: sanitizedPhone
  };
}

async function handleDisconnect() {
  if (waClient) {
    try {
      await waClient.disconnect();
    } catch (err) {
      console.warn('[NodeRunner] Disconnect warning:', err.message);
    }
  }
  return {
    status: 'ok',
    disconnected: true
  };
}

async function dispatchCommand(command, args = {}) {
  const normCmd = String(command || '').toLowerCase().replace(/-/g, '_');
  switch (normCmd) {
    case 'send_message':
    case 'sendmessage':
      return await handleSendMessage(args);
    case 'send_button_message':
    case 'sendbuttonmessage':
      return await handleSendButtonMessage(args);
    case 'request_pairing_code':
    case 'requestpairingcode':
      return await handleRequestPairingCode(args);
    case 'disconnect':
      return await handleDisconnect();
    default:
      return await ipcBridge.dispatchCommand(command, args);
  }
}

// -----------------------------------------------------------------------------
// 6. IPC Transports Registration
// -----------------------------------------------------------------------------

function setupIpcListeners() {
  ipcBridge.registerCommand('send_message', handleSendMessage);
  ipcBridge.registerCommand('send_button_message', handleSendButtonMessage);
  ipcBridge.registerCommand('request_pairing_code', handleRequestPairingCode);
  ipcBridge.registerCommand('disconnect', handleDisconnect);

  ipcBridge.start();
}

// -----------------------------------------------------------------------------
// 7. WaClient Lifecycle and Event Wiring
// -----------------------------------------------------------------------------

async function initializeClient() {
  if (isInitializing) return waClient;
  isInitializing = true;

  const storageDir = process.env.NODEJS_STORAGE_PATH || resolveFilesDir();
  const dbPath = getSessionDbPath(storageDir);
  const walPath = getWalDbPath(storageDir);
  const sessionId = process.env.WA_SESSION_ID || 'default';

  console.log('[NodeRunner] Initializing ZapApp WhatsApp engine...');
  console.log('[NodeRunner] Storage directory: ' + storageDir);
  console.log('[NodeRunner] Session DB path: ' + dbPath);
  console.log('[NodeRunner] SQLite WAL path: ' + walPath);

  // Initialize SQLite persistence store in WAL mode
  persistenceStore = await createPersistenceStore({
    filesDir: storageDir,
    sessionId: sessionId
  });

  const sqliteBackend = createSqliteStore({
    connection: persistenceStore.connection,
    filesDir: storageDir
  });

  const store = createStore({
    backends: { sqlite: sqliteBackend },
    providers: {
      auth: 'sqlite',
      signal: 'sqlite',
      preKey: 'sqlite',
      session: 'sqlite',
      identity: 'sqlite',
      senderKey: 'sqlite',
      appState: 'memory',
      privacyToken: 'memory',
      messages: 'sqlite',
      threads: 'none',
      contacts: 'none'
    }
  });

  waClient = new WaClient({
    store: store,
    sessionId: sessionId,
    ...(process.env.WA_SERVER_URL ? { chatSocketUrls: [process.env.WA_SERVER_URL] } : {})
  });

  // Wire official events to Android bridge

  // 1. 'auth_qr': emits live official QR string from WhatsApp Web server to Android bridge
  waClient.on('auth_qr', (evt) => {
    console.log('[NodeRunner] Live official QR string received from WhatsApp Web server.');
    emitToBridge('auth_qr', {
      qr: evt.qr,
      payload: evt.qr,
      ttl: Math.round((evt.ttlMs || 60000) / 1000),
      ttlMs: evt.ttlMs || 60000
    });
  });

  // Integrate qr-flow handler for SVG generation and seamless QR rotation
  try {
    const { setupQrFlow } = require('./qr-flow');
    if (typeof setupQrFlow === 'function') {
      setupQrFlow(waClient, {
        bridge: {
          send: (evt, data) => emitToBridge(evt, data)
        },
        autoRefresh: true
      });
      console.log('[NodeRunner] Integrated QrFlow handler for SVG generation and QR rotation.');
    }
  } catch (_) {}

  // Integrate pairing-flow handler for 8-digit phone pairing flow
  try {
    const { setupPairingFlow } = require('./pairing-flow');
    if (typeof setupPairingFlow === 'function') {
      pairingFlowHandler = setupPairingFlow(waClient, {
        bridge: {
          send: (evt, data) => emitToBridge(evt, data),
          post: (evt, data) => emitToBridge(evt, data)
        },
        autoListenIpc: false
      });
      console.log('[NodeRunner] Integrated PairingFlow handler for 8-digit phone pairing flow.');
    }
  } catch (_) {}

  // Integrate button-flow handler for interactive native flow button messages
  try {
    if (typeof setupButtonFlow === 'function') {
      setupButtonFlow(waClient, bridgeEmitter);
      console.log('[NodeRunner] Integrated ButtonFlow handler for interactive native flow buttons.');
    }
  } catch (_) {}

  // 2. 'auth_pairing_code': fallback event listener if pairingFlowHandler not active
  if (!pairingFlowHandler) {
    waClient.on('auth_pairing_code', (evt) => {
      console.log('[NodeRunner] Live 8-digit pairing code received:', evt.code);
      const formatted = String(evt.code).length === 8 ? `${String(evt.code).slice(0, 4)}-${String(evt.code).slice(4)}` : evt.code;
      emitToBridge('auth_pairing_code', {
        code: evt.code,
        ttl: 180,
        ttlMs: 180000
      });
      emitToBridge('pairing_code_live', {
        code: evt.code,
        formattedCode: formatted,
        ttl: 180,
        ttlMs: 180000
      });
    });
  }

  // 3. 'auth_paired': emits paired credentials and user JID to Android bridge
  waClient.on('auth_paired', (evt) => {
    const creds = evt.credentials || {};
    const userJid = creds.meJid || creds.jid || '';
    console.log('[NodeRunner] Successfully paired with WhatsApp! User JID:', userJid);
    emitToBridge('auth_paired', {
      jid: userJid,
      meJid: userJid,
      credentials: serializeBytes(creds)
    });
  });

  // 4. 'message': emits incoming decrypted messages to Android bridge
  waClient.on('message', (evt) => {
    const formatted = formatIncomingMessage(evt);
    console.log(`[NodeRunner] Inbound decrypted message from ${formatted.senderJid} (${formatted.id})`);
    emitToBridge('message', formatted);
  });

  // Connection state transition updates
  waClient.on('connection', (evt) => {
    console.log('[NodeRunner] Connection state transition:', evt.status);
    emitToBridge('connection', evt);
  });

  // Auto-connect if not explicitly suppressed in tests
  if (process.env.AUTO_CONNECT !== 'false') {
    waClient.connect().catch((err) => {
      console.warn('[NodeRunner] WaClient background connect status:', err.message);
    });
  }

  isInitializing = false;
  return waClient;
}

// -----------------------------------------------------------------------------
// 8. Application Bootstrap
// -----------------------------------------------------------------------------

async function main() {
  setupIpcListeners();

  try {
    await initializeClient();
    console.log('[NodeRunner] ZapApp Node runtime initialized and bridge listeners active.');

    // Background heartbeat to keep libuv event loop alive on Android
    setInterval(() => {}, 60000);

    // Graceful process exit handling
    const cleanExit = async (signal) => {
      console.log(`[NodeRunner] ${signal} received. Disconnecting client and closing SQLite...`);
      if (waClient) {
        try { await waClient.disconnect(); } catch (_) {}
      }
      if (persistenceStore) {
        try { await persistenceStore.close(); } catch (_) {}
      }
      try {
        await ipcBridge.stop();
      } catch (_) {}
      process.exit(0);
    };

    process.on('SIGTERM', () => cleanExit('SIGTERM'));
    process.on('SIGINT', () => cleanExit('SIGINT'));

    return {
      client: waClient,
      persistence: persistenceStore,
      bridge: bridgeEmitter,
      dispatch: dispatchCommand
    };
  } catch (err) {
    console.error('[NodeRunner] Error during runtime initialization:', err);
    throw err;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[NodeRunner] Fatal startup error:', err);
  });
}

module.exports = {
  main,
  initializeClient,
  dispatchCommand,
  emitToBridge,
  bridgeEmitter,
  ipcBridge,
  getClient: () => waClient,
  getPersistenceStore: () => persistenceStore,
  getPairingFlow: () => pairingFlowHandler
};
