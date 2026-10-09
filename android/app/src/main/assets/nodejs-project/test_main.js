// [xihanzu-NR]
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function runTests() {
  console.log('Testing nodejs-project/main.js zapo-js integration and Android bridge IPC...');

  const tempStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'zapo-main-test-'));
  process.env.NODEJS_STORAGE_PATH = tempStorage;
  process.env.AUTO_CONNECT = 'false'; // Don't attempt live WS connect in unit test
  process.env.NODEJS_IPC_PORT = '28991';

  const {
    main,
    initializeClient,
    dispatchCommand,
    bridgeEmitter,
    getClient,
    getPersistenceStore
  } = require('./main');

  // 1. Initialize client & runtime
  const runtime = await main();
  assert(runtime, 'main() must resolve runtime object');

  const client = getClient();
  assert(client, 'WaClient instance must be initialized');

  const store = getPersistenceStore();
  assert(store, 'Persistence store must be initialized');
  assert.strictEqual(store.filesDir, tempStorage, 'Persistence store must respect NODEJS_STORAGE_PATH');
  assert(fs.existsSync(path.join(tempStorage, 'session.sqlite')), 'session.sqlite must exist');
  assert(fs.existsSync(path.join(tempStorage, 'session.sqlite-wal')), 'session.sqlite-wal must exist in WAL mode');
  console.log('  [PASS] 1. WaClient initialized with SQLite WAL store at NODEJS_STORAGE_PATH');

  // 2. Test event wiring: 'auth_qr'
  let qrEmitted = null;
  bridgeEmitter.once('auth_qr', (data) => {
    qrEmitted = data;
  });
  client.emit('auth_qr', { qr: '2@OFFICIAL_WA_QR_PAYLOAD_STRING', ttlMs: 45000 });
  assert(qrEmitted, 'auth_qr event must be emitted to bridge');
  assert.strictEqual(qrEmitted.qr, '2@OFFICIAL_WA_QR_PAYLOAD_STRING');
  assert.strictEqual(qrEmitted.ttl, 45);
  console.log('  [PASS] 2. Live auth_qr event wired to Android bridge');

  // 3. Test event wiring: 'auth_pairing_code' and 'pairing_code_live'
  let pairingCodeEmitted = null;
  let pairingCodeLiveEmitted = null;
  bridgeEmitter.once('auth_pairing_code', (data) => {
    pairingCodeEmitted = data;
  });
  bridgeEmitter.once('pairing_code_live', (data) => {
    pairingCodeLiveEmitted = data;
  });
  client.emit('auth_pairing_code', { code: '87654321' });
  assert(pairingCodeEmitted, 'auth_pairing_code event must be emitted to bridge');
  assert.strictEqual(pairingCodeEmitted.code, '87654321');
  assert(pairingCodeLiveEmitted, 'pairing_code_live event must be emitted to bridge');
  assert.strictEqual(pairingCodeLiveEmitted.code, '87654321');
  console.log('  [PASS] 3. Live auth_pairing_code & pairing_code_live events wired to Android bridge');

  // 4. Test event wiring: 'auth_paired'
  let pairedEmitted = null;
  bridgeEmitter.once('auth_paired', (data) => {
    pairedEmitted = data;
  });
  client.emit('auth_paired', {
    credentials: {
      meJid: '628123456789@s.whatsapp.net',
      platform: 'android',
      advSecretKey: Buffer.from('test_adv_secret_key')
    }
  });
  assert(pairedEmitted, 'auth_paired event must be emitted to bridge');
  assert.strictEqual(pairedEmitted.meJid, '628123456789@s.whatsapp.net');
  assert.strictEqual(pairedEmitted.jid, '628123456789@s.whatsapp.net');
  console.log('  [PASS] 4. Live auth_paired event wired with user JID and credentials');

  // 5. Test event wiring: 'message'
  let messageEmitted = null;
  bridgeEmitter.once('message', (data) => {
    messageEmitted = data;
  });
  client.emit('message', {
    key: {
      remoteJid: '628123456789@s.whatsapp.net',
      id: 'MSG_INBOUND_001',
      fromMe: false,
      participant: '628123456789@s.whatsapp.net'
    },
    pushName: 'Alice',
    timestampSeconds: 1775720000,
    message: {
      conversation: 'Hello from WhatsApp decrypted message!'
    }
  });
  assert(messageEmitted, 'message event must be emitted to bridge');
  assert.strictEqual(messageEmitted.id, 'MSG_INBOUND_001');
  assert.strictEqual(messageEmitted.chatId, '628123456789@s.whatsapp.net');
  assert.strictEqual(messageEmitted.text, 'Hello from WhatsApp decrypted message!');
  assert.strictEqual(messageEmitted.fromMe, false);
  console.log('  [PASS] 5. Live decrypted message event wired to Android bridge');

  // 6. Test IPC Command: 'send_message'
  let capturedSent = null;
  client.message.send = async (to, text, opts) => {
    capturedSent = { to, text, opts };
    return { id: '3EB0_TEST_ID_1' };
  };

  const sendRes = await dispatchCommand('send_message', {
    to: '628999999999@s.whatsapp.net',
    text: 'Outbound text via IPC'
  });
  assert.strictEqual(sendRes.status, 'ok');
  assert.strictEqual(sendRes.id, '3EB0_TEST_ID_1');
  assert.strictEqual(capturedSent.to, '628999999999@s.whatsapp.net');
  assert.strictEqual(capturedSent.text, 'Outbound text via IPC');
  console.log('  [PASS] 6. IPC command "send_message" verified');

  // 7. Test IPC Command: 'send_button_message'
  let capturedButtonMsg = null;
  client.message.send = async (to, content, opts) => {
    capturedButtonMsg = { to, content, opts };
    return { id: '3EB0_BTN_ID_2' };
  };

  const btnRes = await dispatchCommand('send_button_message', {
    to: '628999999999@s.whatsapp.net',
    text: 'Interactive prompt',
    buttons: [
      { type: 'quick_reply', display_text: 'Accept', id: 'btn_yes' },
      { type: 'cta_url', display_text: 'Details', url: 'https://whatsapp.com' },
      { type: 'cta_copy', display_text: 'Promo', copy_code: 'ZAP2026' }
    ]
  });
  assert.strictEqual(btnRes.status, 'ok');
  assert.strictEqual(btnRes.id, '3EB0_BTN_ID_2');
  assert(capturedButtonMsg.content.viewOnceMessage, 'Interactive button message must be wrapped in viewOnceMessage');
  const innerInteractive = capturedButtonMsg.content.viewOnceMessage.message.interactiveMessage;
  assert.strictEqual(innerInteractive.body.text, 'Interactive prompt');
  assert.strictEqual(innerInteractive.nativeFlowMessage.buttons.length, 3);
  console.log('  [PASS] 7. IPC command "send_button_message" verified with Native Flow & viewOnceMessage');

  // 8. Test IPC Command: 'request_pairing_code'
  client.auth.requestPairingCode = async (phone) => {
    return '12345678';
  };
  let codeEventEmitted = null;
  let liveCodeEmitted = null;
  bridgeEmitter.once('auth_pairing_code', (data) => {
    codeEventEmitted = data;
  });
  bridgeEmitter.once('pairing_code_live', (data) => {
    liveCodeEmitted = data;
  });

  const pairRes = await dispatchCommand('request_pairing_code', {
    phoneNumber: '+62 812-3456-7890'
  });
  assert.strictEqual(pairRes.status, 'ok');
  assert.strictEqual(pairRes.code, '12345678');
  assert.strictEqual(pairRes.phoneNumber, '6281234567890');
  assert(codeEventEmitted, 'auth_pairing_code must also be emitted upon request_pairing_code');
  assert.strictEqual(codeEventEmitted.code, '12345678');
  assert(liveCodeEmitted, 'pairing_code_live must be emitted upon request_pairing_code');
  assert.strictEqual(liveCodeEmitted.code, '12345678');
  assert.strictEqual(liveCodeEmitted.phoneNumber, '6281234567890');
  console.log('  [PASS] 8. IPC command "request_pairing_code" verified with pairing_code_live emission');

  // 9. Test IPC Command: 'disconnect'
  let disconnected = false;
  client.disconnect = async () => {
    disconnected = true;
  };
  const discoRes = await dispatchCommand('disconnect', {});
  assert.strictEqual(discoRes.status, 'ok');
  assert.strictEqual(disconnected, true);
  console.log('  [PASS] 9. IPC command "disconnect" verified');

  // 10. Clean up
  await store.close();
  try {
    fs.rmSync(tempStorage, { recursive: true, force: true });
  } catch (_) {}

  console.log('\nALL MAIN.JS ZAPO-JS & ANDROID BRIDGE TESTS PASSED CLEANLY.');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
