// [xihanzu-NR]
'use strict';

const EventEmitter = require('events');

// ponytail: single active pairing session state; upgrade to multi-tenant session pool if simultaneous multi-device link requests are supported.

// ---------------------------------------------------------------------------
// 1. Phone & Code Formatting Utilities
// ---------------------------------------------------------------------------

const DEFAULT_PAIRING_CODE_TTL = 180; // 180 seconds (3 minutes Meta standard TTL)

/**
 * Normalizes phone numbers into E.164 international format (digits only).
 * Handles strings or objects ({ phoneNumber, phone, number }).
 * Strips '+', spaces, hyphens, parentheses, and leading international '00' prefix.
 */
function formatPhoneNumber(input) {
  let raw = '';
  if (typeof input === 'string' || typeof input === 'number') {
    raw = String(input);
  } else if (input && typeof input === 'object') {
    raw = input.phoneNumber || input.phone || input.number || '';
  }

  if (!raw || typeof raw !== 'string') {
    throw new Error('Valid phone number string required for pairing code');
  }

  // Remove leading +, international 00 prefix, and all non-numeric characters
  let digits = raw.trim().replace(/^\+/, '').replace(/^00/, '').replace(/[^0-9]/g, '');

  if (!digits) {
    throw new Error('Phone number contains no numeric digits');
  }

  // ITU-T E.164 standard: minimum 7 digits, maximum 15 digits
  if (digits.length < 7 || digits.length > 15) {
    throw new Error(`Invalid phone number length (${digits.length} digits): must be 7-15 digits in international format`);
  }

  return digits;
}

/**
 * Formats an 8-character Crockford / Meta pairing code into standard display format (XXXX-XXXX).
 */
function formatPairingCode(code) {
  if (!code) return '';
  const clean = String(code).replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  if (clean.length === 8) {
    return `${clean.slice(0, 4)}-${clean.slice(4)}`;
  }
  return clean;
}

// ---------------------------------------------------------------------------
// 2. Android Bridge IPC Event Dispatcher
// ---------------------------------------------------------------------------

function sendToBridge(event, data, customBridge) {
  const payload = Object.assign({ event }, data);
  let dispatched = false;

  // 1. Explicit custom bridge instance/handler
  if (customBridge) {
    try {
      if (typeof customBridge.post === 'function') {
        try {
          customBridge.post(event, data);
        } catch (_) {
          customBridge.post(payload);
        }
        dispatched = true;
      } else if (typeof customBridge.send === 'function') {
        try {
          customBridge.send(event, data);
        } catch (_) {
          customBridge.send(payload);
        }
        dispatched = true;
      } else if (typeof customBridge.emit === 'function') {
        customBridge.emit(event, data);
        dispatched = true;
      } else if (typeof customBridge === 'function') {
        customBridge(event, data);
        dispatched = true;
      }
    } catch (err) {
      console.warn('[PairingFlow] customBridge dispatch error:', err.message);
    }
  }

  // 2. Janea Systems rn-bridge (React Native / Node.js Mobile standard)
  try {
    const rnBridge = require('rn-bridge');
    if (rnBridge && rnBridge.channel) {
      if (typeof rnBridge.channel.post === 'function') {
        rnBridge.channel.post(event, data);
        dispatched = true;
      }
      if (typeof rnBridge.channel.send === 'function') {
        rnBridge.channel.send(JSON.stringify(payload));
        dispatched = true;
      }
    }
  } catch (_) {
    // Not running inside rn-bridge container
  }

  // 3. Node.js process IPC channel (child_process.fork)
  if (typeof process.send === 'function') {
    try {
      process.send(payload);
      dispatched = true;
    } catch (err) {
      console.warn('[PairingFlow] process.send error:', err.message);
    }
  }

  // 4. Global Android WebView / Native bridge
  if (typeof global !== 'undefined') {
    if (global.__ANDROID_BRIDGE__) {
      try {
        const b = global.__ANDROID_BRIDGE__;
        if (typeof b.post === 'function') { b.post(event, JSON.stringify(data)); dispatched = true; }
        else if (typeof b.send === 'function') { b.send(JSON.stringify(payload)); dispatched = true; }
      } catch (_) {}
    }
    if (global.ZapBridge) {
      try {
        const b = global.ZapBridge;
        if (typeof b.onPairingCodeLive === 'function') { b.onPairingCodeLive(data); dispatched = true; }
        else if (typeof b.send === 'function') { b.send(JSON.stringify(payload)); dispatched = true; }
      } catch (_) {}
    }
  }

  // 5. Line-delimited stdout log for Android Logcat log capture
  try {
    if (!customBridge) {
      console.log(`[BRIDGE_EVENT] ${JSON.stringify(payload)}`);
    }
  } catch (_) {}

  return dispatched;
}

// ---------------------------------------------------------------------------
// 3. Pairing Flow Controller
// ---------------------------------------------------------------------------

class PairingFlowHandler extends EventEmitter {
  constructor(engine, options = {}) {
    super();
    this.engine = engine || null;
    this.options = options;
    this.bridge = options.bridge || null;
    this.defaultTtl = options.defaultTtl || DEFAULT_PAIRING_CODE_TTL;

    this.currentCode = null;
    this.formattedCode = null;
    this.phoneNumber = null;
    this.expiresAt = null;
    this.isActive = false;
    this._expirationTimer = null;

    if (this.engine) {
      this.attachEngine(this.engine);
    }

    if (options.autoListenIpc !== false) {
      this.attachIpcListeners();
    }
  }

  attachEngine(engine) {
    this.engine = engine;

    // Listen for engine-level 'auth_pairing_code' events from Meta server IQ response
    if (typeof engine.on === 'function') {
      engine.on('auth_pairing_code', (evt) => {
        const code = evt?.code || evt;
        if (code && typeof code === 'string') {
          this.handleLiveCode(code, evt?.ttl || this.defaultTtl);
        }
      });
    }
  }

  attachIpcListeners() {
    // 1. rn-bridge channel command listener
    try {
      const rnBridge = require('rn-bridge');
      if (rnBridge && rnBridge.channel) {
        rnBridge.channel.on('request_pairing_code', async (args) => {
          try {
            await this.requestPairingCode(args);
          } catch (err) {
            console.error('[PairingFlow:rn-bridge] request_pairing_code error:', err.message);
          }
        });

        rnBridge.channel.on('message', async (msg) => {
          try {
            const parsed = typeof msg === 'string' ? JSON.parse(msg) : msg;
            const cmd = parsed?.command || parsed?.action || parsed?.type;
            if (cmd === 'request_pairing_code') {
              const args = parsed.args || parsed.payload || parsed.data || parsed;
              const res = await this.requestPairingCode(args);
              if (parsed.reqId) {
                rnBridge.channel.send(JSON.stringify({ reqId: parsed.reqId, status: 'ok', result: res }));
              }
            }
          } catch (_) {}
        });
      }
    } catch (_) {}

    // 2. process IPC command listener
    if (typeof process.on === 'function') {
      process.on('message', async (msg) => {
        try {
          if (!msg) return;
          const cmd = msg.command || msg.action || msg.type;
          if (cmd === 'request_pairing_code') {
            const args = msg.args || msg.payload || msg.data || msg;
            const res = await this.requestPairingCode(args);
            if (msg.reqId && typeof process.send === 'function') {
              process.send({ reqId: msg.reqId, status: 'ok', result: res });
            }
          }
        } catch (_) {}
      });
    }
  }

  /**
   * Main entry point when Android bridge sends 'request_pairing_code' with phoneNumber.
   * 1. Formats phone number.
   * 2. Requests official companion link code via WaPairingFlow / WaClient.requestPairingCode.
   * 3. Emits event 'pairing_code_live' with real 8-digit code from Meta to Android bridge.
   */
  async requestPairingCode(phoneInput, options = {}) {
    const formattedPhone = formatPhoneNumber(phoneInput);
    this.phoneNumber = formattedPhone;

    const ttl = options.ttl || this.defaultTtl;
    let code = null;

    // Request pairing code via engine / WaPairingFlow / WaClient
    if (this.engine) {
      if (this.engine.auth && typeof this.engine.auth.requestPairingCode === 'function') {
        code = await this.engine.auth.requestPairingCode(formattedPhone);
      } else if (typeof this.engine.requestPairingCode === 'function') {
        code = await this.engine.requestPairingCode(formattedPhone);
      } else if (this.engine.pairingFlow && typeof this.engine.pairingFlow.requestPairingCode === 'function') {
        code = await this.engine.pairingFlow.requestPairingCode(formattedPhone);
      }
    }

    if (!code) {
      throw new Error('Could not request pairing code: No active WaClient or WaPairingFlow engine available');
    }

    // Clean and validate 8-character Meta code
    const rawCode = String(code).trim().replace(/[^0-9A-Za-z]/g, '').toUpperCase();
    return this.handleLiveCode(rawCode, ttl);
  }

  /**
   * Broadcasts the live 8-digit code to the Android bridge and manages expiration timer.
   */
  handleLiveCode(rawCode, ttlSeconds) {
    const ttl = ttlSeconds || this.defaultTtl;
    const formatted = formatPairingCode(rawCode);

    this.currentCode = rawCode;
    this.formattedCode = formatted;
    this.isActive = true;
    this.expiresAt = Date.now() + (ttl * 1000);

    if (this._expirationTimer) {
      clearTimeout(this._expirationTimer);
    }
    this._expirationTimer = setTimeout(() => {
      this._onCodeExpired();
    }, ttl * 1000);

    const livePayload = {
      code: rawCode,
      formattedCode: formatted,
      phoneNumber: this.phoneNumber,
      ttl: ttl,
      ttlMs: ttl * 1000,
      expiresAt: this.expiresAt,
      timestamp: Date.now()
    };

    // 1. Primary event requested by Android bridge
    sendToBridge('pairing_code_live', livePayload, this.bridge);
    this.emit('pairing_code_live', livePayload);

    // 2. Compatibility event for standard zapo auth listeners
    sendToBridge('auth_pairing_code', livePayload, this.bridge);
    this.emit('auth_pairing_code', livePayload);

    return livePayload;
  }

  _onCodeExpired() {
    this.isActive = false;
    const expiredPayload = {
      code: this.currentCode,
      formattedCode: this.formattedCode,
      phoneNumber: this.phoneNumber,
      expired: true,
      timestamp: Date.now()
    };

    sendToBridge('pairing_code_expired', expiredPayload, this.bridge);
    this.emit('pairing_code_expired', expiredPayload);
  }

  getState() {
    const remainingMs = this.expiresAt ? Math.max(0, this.expiresAt - Date.now()) : 0;
    return {
      isActive: this.isActive,
      code: this.currentCode,
      formattedCode: this.formattedCode,
      phoneNumber: this.phoneNumber,
      expiresAt: this.expiresAt,
      remainingSecs: Math.ceil(remainingMs / 1000)
    };
  }

  reset() {
    if (this._expirationTimer) {
      clearTimeout(this._expirationTimer);
      this._expirationTimer = null;
    }
    this.currentCode = null;
    this.formattedCode = null;
    this.phoneNumber = null;
    this.expiresAt = null;
    this.isActive = false;
  }

  destroy() {
    this.reset();
    this.removeAllListeners();
  }
}

function createPairingFlow(engine, options) {
  return new PairingFlowHandler(engine, options);
}

const setupPairingFlow = createPairingFlow;

// ---------------------------------------------------------------------------
// 4. Runnable Self-Check (Zero-framework verification)
// ---------------------------------------------------------------------------

async function runSelfCheck() {
  const assert = require('assert');
  console.log('[PairingFlow] Running self-check...');

  // 1. Test Phone Number Formatting
  assert.strictEqual(formatPhoneNumber('+62 812-3456-7890'), '6281234567890');
  assert.strictEqual(formatPhoneNumber('001 (555) 234-5678'), '15552345678');
  assert.strictEqual(formatPhoneNumber({ phoneNumber: '+55 11 99999-8888' }), '5511999998888');
  assert.throws(() => formatPhoneNumber('123'), /Invalid phone number length/);
  assert.throws(() => formatPhoneNumber(''), /Valid phone number string required/);
  console.log('  [PASS] 1. Phone number formatting & validation verified.');

  // 2. Test Pairing Code Formatting
  assert.strictEqual(formatPairingCode('12345678'), '1234-5678');
  assert.strictEqual(formatPairingCode('abcd1234'), 'ABCD-1234');
  assert.strictEqual(formatPairingCode('3R7G9W2X'), '3R7G-9W2X');
  console.log('  [PASS] 2. 8-digit Crockford code formatting verified.');

  // 3. Test Pairing Flow Execution & Bridge IPC Dispatch
  const emittedEvents = [];
  const mockBridge = {
    post: (evt, data) => emittedEvents.push({ evt, data }),
    send: (evt, data) => emittedEvents.push({ evt, data })
  };

  let requestedPhone = null;
  const mockEngine = new EventEmitter();
  mockEngine.auth = {
    requestPairingCode: async (phone) => {
      requestedPhone = phone;
      return '87654321';
    }
  };

  const flow = createPairingFlow(mockEngine, {
    bridge: mockBridge,
    defaultTtl: 180,
    autoListenIpc: false
  });

  let liveEventReceived = null;
  flow.once('pairing_code_live', (data) => {
    liveEventReceived = data;
  });

  const result = await flow.requestPairingCode('+62 812-3456-7890');

  assert.strictEqual(requestedPhone, '6281234567890', 'Engine must receive sanitized phone number');
  assert.strictEqual(result.code, '87654321', 'Result must contain 8-digit code');
  assert.strictEqual(result.formattedCode, '8765-4321', 'Result must contain formatted code');
  assert.strictEqual(result.phoneNumber, '6281234567890', 'Result must contain formatted phone');
  assert(liveEventReceived, 'flow must emit pairing_code_live');
  assert.strictEqual(liveEventReceived.code, '87654321');

  // Verify bridge received 'pairing_code_live'
  const bridgeLiveEvent = emittedEvents.find((e) => e.evt === 'pairing_code_live');
  assert(bridgeLiveEvent, 'Android bridge must receive pairing_code_live event');
  assert.strictEqual(bridgeLiveEvent.data.code, '87654321');
  assert.strictEqual(bridgeLiveEvent.data.formattedCode, '8765-4321');
  console.log('  [PASS] 3. request_pairing_code requests Meta code and emits pairing_code_live to bridge.');

  flow.destroy();
  console.log('[PairingFlow] All self-checks passed successfully.');
}

if (require.main === module) {
  runSelfCheck().catch((err) => {
    console.error('[PairingFlow] Self-check failed:', err);
    process.exit(1);
  });
}

module.exports = {
  PairingFlowHandler,
  createPairingFlow,
  setupPairingFlow,
  formatPhoneNumber,
  formatPairingCode,
  sendToBridge,
  runSelfCheck
};
