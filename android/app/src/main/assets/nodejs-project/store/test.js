// [xihanzu-NR]
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  createPersistenceStore,
  resolveFilesDir,
  getSessionDbPath,
  getWalDbPath,
  openSqliteConnection
} = require('./index');

async function runTests() {
  console.log('Starting SQLite persistence verification tests for zapo...');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapo-store-test-'));
  const expectedDb = path.join(tempDir, 'session.sqlite');
  const expectedWal = path.join(tempDir, 'session.sqlite-wal');

  try {
    // 1. Verify filesDir resolution and DB paths
    const resolvedDir = resolveFilesDir(tempDir);
    assert.strictEqual(resolvedDir, tempDir, 'resolveFilesDir must match custom directory');
    const dbPath = getSessionDbPath(tempDir);
    assert.strictEqual(dbPath, expectedDb, 'getSessionDbPath must point to filesDir + /session.sqlite');
    const walPath = getWalDbPath(tempDir);
    assert.strictEqual(walPath, expectedWal, 'getWalDbPath must point to filesDir + /session.sqlite-wal');
    console.log('  [PASS] 1. Path resolution verified: ' + dbPath);

    // 2. Initialize persistence store with WAL mode
    const store = await createPersistenceStore({ filesDir: tempDir });
    assert(store, 'Store instance created');
    assert.strictEqual(store.dbPath, expectedDb);

    // Verify WAL mode pragma
    const pragmaRes = store.connection.all('PRAGMA journal_mode;');
    const mode = pragmaRes[0] ? (pragmaRes[0].journal_mode || Object.values(pragmaRes[0])[0]) : '';
    assert.strictEqual(String(mode).toLowerCase(), 'wal', 'journal_mode must be WAL');
    assert(fs.existsSync(expectedWal), 'session.sqlite-wal file must exist on disk in WAL mode');
    console.log('  [PASS] 2. SQLite initialized in WAL mode with session.sqlite-wal');

    // 3. Test Auth Keys Persistence
    const mockCredentials = {
      noiseKeyPair: {
        pubKey: Buffer.from('noise_public_key_32_bytes_test__'),
        privKey: Buffer.from('noise_private_key_32_bytes_test_')
      },
      registrationInfo: {
        registrationId: 98765,
        identityKeyPair: {
          pubKey: Buffer.from('identity_public_key_32_bytes_tes'),
          privKey: Buffer.from('identity_private_key_32_bytes_te')
        }
      },
      signedPreKey: {
        keyId: 42,
        keyPair: {
          pubKey: Buffer.from('signed_prekey_pub_32_bytes_test_'),
          privKey: Buffer.from('signed_prekey_priv_32_bytes_test')
        },
        signature: Buffer.from('signed_prekey_sig_64_bytes_test_test_test_test_test_test_test_te'),
        uploaded: false
      },
      advSecretKey: Buffer.from('adv_secret_key_32_bytes_test____'),
      meJid: '6281234567890@s.whatsapp.net',
      meLid: '1234567890@lid',
      meDisplayName: 'ZapApp Android Tester',
      platform: 'android'
    };

    await store.auth.save(mockCredentials);
    const loadedCreds = await store.auth.load();
    assert(loadedCreds, 'Loaded credentials must exist');
    assert.strictEqual(loadedCreds.registrationInfo.registrationId, 98765);
    assert.strictEqual(loadedCreds.meJid, '6281234567890@s.whatsapp.net');
    assert.strictEqual(loadedCreds.meDisplayName, 'ZapApp Android Tester');
    assert.deepStrictEqual(loadedCreds.noiseKeyPair.pubKey, mockCredentials.noiseKeyPair.pubKey);
    assert.deepStrictEqual(loadedCreds.advSecretKey, mockCredentials.advSecretKey);
    console.log('  [PASS] 3. Auth credentials and keys persisted and loaded cleanly');

    // 4. Test Signal Identities Persistence
    const testAddress = { user: '628999888777', server: 's.whatsapp.net', device: 0 };
    const testIdentityKey = Buffer.from('identity_key_remote_contact_32b_');
    await store.identity.setRemoteIdentity(testAddress, testIdentityKey);

    const gotIdentity = await store.identity.getRemoteIdentity(testAddress);
    assert(gotIdentity, 'Remote identity must be found');
    assert.deepStrictEqual(gotIdentity, testIdentityKey);

    const missingIdentity = await store.identity.getRemoteIdentity('unknown@s.whatsapp.net');
    assert.strictEqual(missingIdentity, null, 'Unknown identity must return null');
    console.log('  [PASS] 4. Signal identities persisted and queried cleanly');

    // 5. Test Signal Sessions Persistence
    const sessionRecordBuf = Buffer.from('ratchet_session_state_bytes_serialized_data_12345');
    await store.session.setSession(testAddress, sessionRecordBuf);

    const hasSession = await store.session.hasSession(testAddress);
    assert.strictEqual(hasSession, true, 'hasSession must return true');

    const gotSession = await store.session.getSession(testAddress);
    assert(gotSession, 'Session record must exist');
    assert.deepStrictEqual(gotSession, sessionRecordBuf);

    const hasBatch = await store.session.hasSessions([testAddress, 'nonexistent@s.whatsapp.net']);
    assert.deepStrictEqual(hasBatch, [true, false], 'hasSessions batch check');
    console.log('  [PASS] 5. Signal sessions persisted and queried cleanly');

    // 6. Test Messages Persistence (CRUD & thread pagination)
    const msg1 = {
      id: 'MSG_001',
      threadJid: '628999888777@s.whatsapp.net',
      senderJid: '628999888777@s.whatsapp.net',
      fromMe: false,
      timestampMs: 1728000000000,
      messageBytes: Buffer.from('Hello from peer')
    };
    const msg2 = {
      id: 'MSG_002',
      threadJid: '628999888777@s.whatsapp.net',
      senderJid: '6281234567890@s.whatsapp.net',
      fromMe: true,
      timestampMs: 1728000001000,
      messageBytes: Buffer.from('Hello back from ZapApp')
    };

    await store.messages.upsert(msg1);
    await store.messages.upsert(msg2);

    const gotMsg1 = await store.messages.getById('MSG_001');
    assert(gotMsg1, 'MSG_001 must exist');
    assert.strictEqual(gotMsg1.fromMe, false);
    assert.deepStrictEqual(gotMsg1.messageBytes, Buffer.from('Hello from peer'));

    const threadMsgs = await store.messages.listByThread('628999888777@s.whatsapp.net', 10);
    assert.strictEqual(threadMsgs.length, 2, 'Thread must contain 2 messages');
    assert.strictEqual(threadMsgs[0].id, 'MSG_002', 'Newest message must appear first');

    const deleted = await store.messages.deleteById('MSG_001');
    assert.strictEqual(deleted, 1, 'deleteById must report 1 change');
    const remainingMsgs = await store.messages.listByThread('628999888777@s.whatsapp.net', 10);
    assert.strictEqual(remainingMsgs.length, 1);
    console.log('  [PASS] 6. Message CRUD and thread pagination verified');

    // 7. Test WAL checkpoint and recovery across restart
    await store.close();

    // Reopen store from disk and verify data persists
    const reopenedStore = await createPersistenceStore({ filesDir: tempDir });
    const recoveredCreds = await reopenedStore.auth.load();
    assert(recoveredCreds, 'Recovered credentials must exist');
    assert.strictEqual(recoveredCreds.meJid, '6281234567890@s.whatsapp.net');

    const recoveredSession = await reopenedStore.session.getSession(testAddress);
    assert.deepStrictEqual(recoveredSession, sessionRecordBuf);

    const recoveredIdentity = await reopenedStore.identity.getRemoteIdentity(testAddress);
    assert.deepStrictEqual(recoveredIdentity, testIdentityKey);

    const recoveredMessages = await reopenedStore.messages.listByThread('628999888777@s.whatsapp.net');
    assert.strictEqual(recoveredMessages.length, 1);
    assert.strictEqual(recoveredMessages[0].id, 'MSG_002');
    await reopenedStore.close();
    console.log('  [PASS] 7. Crash recovery & restart verification passed');

    console.log('\nALL SQLite PERSISTENCE TESTS PASSED CLEANLY.');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runTests().catch(err => {
    console.error('Test failed with error:', err);
    process.exit(1);
  });
}

module.exports = { runTests };
