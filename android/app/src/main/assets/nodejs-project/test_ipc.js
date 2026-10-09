// [xihanzu-NR]
'use strict';

const assert = require('assert');
const net = require('net');
const {
  IpcBridge,
  createIpcBridge,
  serializeEvent,
  serializeResponse,
  serializeCommand,
  safeStringify,
  deserialize,
  safeParse,
  normalizeMessage,
  formatLine,
  parseLine,
  createLineDecoder,
  IpcParseError
} = require('./ipc');

// ponytail: in-process assertions for serialization and framing mechanics; upgrade to integration harness against Android adb logcat if live runtime validation needed.

async function runTests() {
  console.log('Testing nodejs-project/ipc.js IPC bridge module...');

  // ---------------------------------------------------------------------------
  // 1. Serialization Tests
  // ---------------------------------------------------------------------------
  // 1.1 serializeEvent
  const evt1 = serializeEvent('auth_qr', { qr: 'qr_string_123', ttl: 45 });
  assert.strictEqual(evt1.event, 'auth_qr');
  assert.strictEqual(evt1.data.qr, 'qr_string_123');
  assert.strictEqual(evt1.data.ttl, 45);
  assert(typeof evt1.timestamp === 'number');

  const evt2 = serializeEvent('simple_event', 'simple_value', 1234567890);
  assert.strictEqual(evt2.event, 'simple_event');
  assert.strictEqual(evt2.data.value, 'simple_value');
  assert.strictEqual(evt2.timestamp, 1234567890);

  assert.throws(() => serializeEvent(''), TypeError);
  console.log('  [PASS] 1.1 serializeEvent formats events correctly');

  // 1.2 serializeResponse
  const respOk = serializeResponse('req_1', { msgId: 'ABC' });
  assert.strictEqual(respOk.reqId, 'req_1');
  assert.strictEqual(respOk.status, 'ok');
  assert.strictEqual(respOk.result.msgId, 'ABC');
  assert.strictEqual(respOk.error, undefined);

  const respErr = serializeResponse('req_2', null, new Error('Something failed'));
  assert.strictEqual(respErr.reqId, 'req_2');
  assert.strictEqual(respErr.status, 'error');
  assert.strictEqual(respErr.error, 'Something failed');
  assert.strictEqual(respErr.result, undefined);
  console.log('  [PASS] 1.2 serializeResponse formats success & failure correctly');

  // 1.3 serializeCommand
  const cmd = serializeCommand('send_message', { to: '123', text: 'hi' }, 'req_99');
  assert.strictEqual(cmd.command, 'send_message');
  assert.strictEqual(cmd.args.to, '123');
  assert.strictEqual(cmd.reqId, 'req_99');
  console.log('  [PASS] 1.3 serializeCommand formats outbound commands correctly');

  // 1.4 safeStringify
  const circularObj = { name: 'test' };
  circularObj.self = circularObj;
  const jsonCirc = safeStringify(circularObj);
  assert(jsonCirc.includes('[Circular]'));

  const bufObj = { data: Buffer.from('hello zapo') };
  const jsonBuf = safeStringify(bufObj);
  assert(jsonBuf.includes('base64'));

  const bigIntObj = { count: 9007199254740991000n };
  const jsonBigInt = safeStringify(bigIntObj);
  assert(jsonBigInt.includes('9007199254740991000'));
  console.log('  [PASS] 1.4 safeStringify handles circular references, buffers, and BigInt');

  // 1.5 formatLine
  const line = formatLine({ hello: 'world' });
  assert(line.endsWith('\n'));
  assert.strictEqual(JSON.parse(line.trim()).hello, 'world');
  console.log('  [PASS] 1.5 formatLine creates newline-delimited JSON line');

  // ---------------------------------------------------------------------------
  // 2. Deserialization & Normalization Tests
  // ---------------------------------------------------------------------------
  // 2.1 deserialize
  const parsed1 = deserialize('{"a":1}\n');
  assert.strictEqual(parsed1.a, 1);
  const parsed2 = deserialize(Buffer.from('{"b":"two"}\r\n'));
  assert.strictEqual(parsed2.b, 'two');
  assert.throws(() => deserialize(''), IpcParseError);
  assert.throws(() => deserialize('{invalid_json'), IpcParseError);
  console.log('  [PASS] 2.1 deserialize parses string & Buffer cleanly');

  // 2.2 normalizeMessage
  const normCmd = normalizeMessage({ command: 'send_message', args: { to: 'xyz' }, reqId: 'req_1' });
  assert.strictEqual(normCmd.type, 'command');
  assert.strictEqual(normCmd.command, 'send_message');
  assert.strictEqual(normCmd.args.to, 'xyz');
  assert.strictEqual(normCmd.reqId, 'req_1');

  // alternative field names from different client shapes
  const normCmdAlt = normalizeMessage({ action: 'disconnect', payload: { force: true }, id: 42 });
  assert.strictEqual(normCmdAlt.type, 'command');
  assert.strictEqual(normCmdAlt.command, 'disconnect');
  assert.strictEqual(normCmdAlt.args.force, true);
  assert.strictEqual(normCmdAlt.reqId, '42');

  const normResp = normalizeMessage({ reqId: 'req_1', status: 'ok', result: { done: true } });
  assert.strictEqual(normResp.type, 'response');
  assert.strictEqual(normResp.result.done, true);

  const normEvt = normalizeMessage({ event: 'auth_qr', data: { qr: 'code' }, timestamp: 100 });
  assert.strictEqual(normEvt.type, 'event');
  assert.strictEqual(normEvt.event, 'auth_qr');
  assert.strictEqual(normEvt.data.qr, 'code');
  console.log('  [PASS] 2.2 normalizeMessage classifies command, response, and event cleanly');

  // ---------------------------------------------------------------------------
  // 3. Line Framing Decoder Tests
  // ---------------------------------------------------------------------------
  const decoded = [];
  const errors = [];
  const decoder = createLineDecoder(
    (msg, raw) => decoded.push({ msg, raw }),
    (err, raw) => errors.push({ err, raw })
  );

  // Chunk 1: half of line 1
  decoder.push('{"command":"first"');
  assert.strictEqual(decoded.length, 0);

  // Chunk 2: rest of line 1 + full line 2 + start of line 3
  decoder.push(',"reqId":"1"}\n{"command":"second","reqId":"2"}\r\n{"command":"th');
  assert.strictEqual(decoded.length, 2);
  assert.strictEqual(decoded[0].msg.command, 'first');
  assert.strictEqual(decoded[1].msg.command, 'second');

  // Chunk 3: rest of line 3 + corrupted line 4 + line 5
  decoder.push('ird","reqId":"3"}\ncorrupted_line\n{"command":"fifth","reqId":"5"}\n');
  assert.strictEqual(decoded.length, 4);
  assert.strictEqual(decoded[2].msg.command, 'third');
  assert.strictEqual(decoded[3].msg.command, 'fifth');
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].raw, 'corrupted_line');
  console.log('  [PASS] 3. createLineDecoder handles chunk fragmentation and recovery');

  // ---------------------------------------------------------------------------
  // 4. Live TCP IpcBridge Server & Client Socket Test
  // ---------------------------------------------------------------------------
  const testPort = 28994;
  const bridge = createIpcBridge({
    port: testPort,
    host: '127.0.0.1',
    enableStdio: false, // Don't hook process.stdin in unit test
    enableProcessIpc: false,
    enableRnBridge: false
  });

  bridge.registerCommand('test_echo', async (args) => {
    return { echo: args.text, time: Date.now() };
  });

  bridge.registerCommand('test_fail', async () => {
    throw new Error('Intentional command error');
  });

  await bridge.start();

  // Connect TCP client socket simulating Java NodeRunner socket
  const clientSocket = new net.Socket();
  const receivedLines = [];

  const clientConnected = new Promise((resolve, reject) => {
    clientSocket.connect(testPort, '127.0.0.1', () => resolve());
    clientSocket.on('error', reject);
  });

  const clientDecoder = createLineDecoder((msg, raw) => {
    receivedLines.push(msg);
  });
  clientSocket.on('data', (chunk) => clientDecoder.push(chunk));

  await clientConnected;

  // 4.1 Send command from client -> bridge
  clientSocket.write('{"command":"test_echo","args":{"text":"hello world"},"reqId":"req_echo_1"}\n');

  // Wait for response
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(receivedLines.length >= 1, 'Client must receive response');
  const resp1 = receivedLines.find((r) => r.reqId === 'req_echo_1');
  assert(resp1, 'Response must match reqId');
  assert.strictEqual(resp1.status, 'ok');
  assert.strictEqual(resp1.result.echo, 'hello world');
  console.log('  [PASS] 4.1 TCP Command roundtrip verified');

  // 4.2 Send failing command
  clientSocket.write('{"command":"test_fail","args":{},"reqId":"req_fail_1"}\n');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const resp2 = receivedLines.find((r) => r.reqId === 'req_fail_1');
  assert(resp2, 'Failure response must match reqId');
  assert.strictEqual(resp2.status, 'error');
  assert.strictEqual(resp2.error, 'Intentional command error');
  console.log('  [PASS] 4.2 TCP Command error handling verified');

  // 4.3 Send broadcast event from bridge -> client
  let localEventReceived = false;
  bridge.once('auth_qr', (data) => {
    localEventReceived = (data.qr === 'test_qr_123');
  });

  bridge.sendEvent('auth_qr', { qr: 'test_qr_123', ttl: 45 });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert(localEventReceived, 'Local event emitter must receive event');
  const evtMsg = receivedLines.find((r) => r.type === 'event' && r.event === 'auth_qr');
  assert(evtMsg, 'TCP client must receive serialized event');
  assert.strictEqual(evtMsg.data.qr, 'test_qr_123');
  assert.strictEqual(evtMsg.data.ttl, 45);
  console.log('  [PASS] 4.3 TCP Event broadcast verified');

  // 4.4 Test built-in ping command
  clientSocket.write('{"command":"ping","args":{},"reqId":"req_ping_1"}\n');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const respPing = receivedLines.find((r) => r.reqId === 'req_ping_1');
  assert(respPing, 'Ping response must match reqId');
  assert.strictEqual(respPing.result.pong, true);
  console.log('  [PASS] 4.4 Built-in ping command verified');

  // Clean up
  clientSocket.destroy();
  await bridge.stop();
  console.log('  [PASS] 4.5 Clean socket & server shutdown verified');

  console.log('\nALL IPC BRIDGE MODULE TESTS PASSED CLEANLY.');
}

runTests().catch((err) => {
  console.error('IPC Test failed with error:', err);
  process.exit(1);
});
