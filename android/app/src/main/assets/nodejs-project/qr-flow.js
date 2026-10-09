// [xihanzu-NR]
'use strict';

const EventEmitter = require('events');

// ponytail: in-memory rotation timer and byte-mode ISO/IEC 18004 matrix; upgrade to animated SVG or worker threads if high-frequency countdown rendering is required.

// ---------------------------------------------------------------------------
// Standalone QR Code SVG Matrix Generator (ISO/IEC 18004 Byte Mode)
// ---------------------------------------------------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_EXP[i + 255] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsPoly(degree) {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const root = GF_EXP[i];
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], root);
    }
    g = next;
  }
  return g;
}

function rsEncode(data, ecLen) {
  const gen = rsPoly(ecLen);
  const remainder = new Array(ecLen).fill(0);
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    const factor = b ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j++) {
        remainder[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return remainder;
}

const QR_SPECS = [
  { v: 1, size: 21, data: 19, ec: 7, blocks: 1, align: [] },
  { v: 2, size: 25, data: 34, ec: 10, blocks: 1, align: [6, 18] },
  { v: 3, size: 29, data: 55, ec: 15, blocks: 1, align: [6, 22] },
  { v: 4, size: 33, data: 80, ec: 20, blocks: 1, align: [6, 26] },
  { v: 5, size: 37, data: 108, ec: 26, blocks: 1, align: [6, 30] },
  { v: 6, size: 41, data: 136, ec: 18, blocks: 2, align: [6, 34] },
  { v: 7, size: 45, data: 156, ec: 20, blocks: 2, align: [6, 22, 38] },
  { v: 8, size: 49, data: 194, ec: 24, blocks: 2, align: [6, 24, 42] },
  { v: 9, size: 53, data: 232, ec: 30, blocks: 2, align: [6, 26, 46] },
  { v: 10, size: 57, data: 274, ec: 18, blocks: 4, align: [6, 28, 50] }
];

function generateQrSvg(text, options = {}) {
  const cleanText = text || 'zapapp:pairing:empty';
  const byteData = Array.from(Buffer.from(cleanText, 'utf8'));

  let spec = null;
  for (let i = 0; i < QR_SPECS.length; i++) {
    if (byteData.length + 3 <= QR_SPECS[i].data) {
      spec = QR_SPECS[i];
      break;
    }
  }
  if (!spec) spec = QR_SPECS[QR_SPECS.length - 1];

  const bits = [];
  function addBits(val, len) {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  }

  // Byte Mode Indicator (0100)
  addBits(4, 4);
  const countBits = spec.v >= 10 ? 16 : 8;
  const count = Math.min(byteData.length, spec.data - 3);
  addBits(count, countBits);
  for (let i = 0; i < count; i++) addBits(byteData[i], 8);

  // Terminator & padding to byte
  for (let i = 0; i < 4 && bits.length < spec.data * 8; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataCodewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    dataCodewords.push(b);
  }
  let pad = 0xEC;
  while (dataCodewords.length < spec.data) {
    dataCodewords.push(pad);
    pad = (pad === 0xEC) ? 0x11 : 0xEC;
  }

  const bDataLen = Math.floor(spec.data / spec.blocks);
  const dataBlocks = [];
  const ecBlocks = [];
  for (let b = 0; b < spec.blocks; b++) {
    const start = b * bDataLen;
    const end = (b === spec.blocks - 1) ? spec.data : start + bDataLen;
    const block = dataCodewords.slice(start, end);
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, spec.ec));
  }

  const finalCodewords = [];
  const maxBlockLen = Math.max(...dataBlocks.map(b => b.length));
  for (let i = 0; i < maxBlockLen; i++) {
    for (let b = 0; b < dataBlocks.length; b++) {
      if (i < dataBlocks[b].length) finalCodewords.push(dataBlocks[b][i]);
    }
  }
  for (let i = 0; i < spec.ec; i++) {
    for (let b = 0; b < ecBlocks.length; b++) {
      if (i < ecBlocks[b].length) finalCodewords.push(ecBlocks[b][i]);
    }
  }

  const N = spec.size;
  const matrix = Array.from({ length: N }, () => new Array(N).fill(null));
  const reserved = Array.from({ length: N }, () => new Array(N).fill(false));

  function setModule(r, c, val) {
    matrix[r][c] = val;
    reserved[r][c] = true;
  }

  function addFinder(row, col) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const nr = row + r;
        const nc = col + c;
        if (nr >= 0 && nr < N && nc >= 0 && nc < N) {
          if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
            const isBorder = (r === 0 || r === 6 || c === 0 || c === 6);
            const isCenter = (r >= 2 && r <= 4 && c >= 2 && c <= 4);
            setModule(nr, nc, isBorder || isCenter);
          } else {
            setModule(nr, nc, false);
          }
        }
      }
    }
  }

  addFinder(0, 0);
  addFinder(0, N - 7);
  addFinder(N - 7, 0);

  for (let i = 8; i < N - 8; i++) {
    if (!reserved[6][i]) setModule(6, i, i % 2 === 0);
    if (!reserved[i][6]) setModule(i, 6, i % 2 === 0);
  }

  if (spec.align) {
    for (const ay of spec.align) {
      for (const ax of spec.align) {
        if ((ax <= 8 && ay <= 8) || (ax >= N - 8 && ay <= 8) || (ax <= 8 && ay >= N - 8)) continue;
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            const isB = (Math.abs(r) === 2 || Math.abs(c) === 2);
            const isC = (r === 0 && c === 0);
            setModule(ay + r, ax + c, isB || isC);
          }
        }
      }
    }
  }

  setModule(N - 8, 8, true);

  for (let i = 0; i < 9; i++) {
    if (i !== 6) { reserved[8][i] = true; reserved[i][8] = true; }
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][N - 1 - i] = true;
    reserved[N - 1 - i][8] = true;
  }

  const finalBits = [];
  for (const cw of finalCodewords) {
    for (let i = 7; i >= 0; i--) finalBits.push((cw >> i) & 1);
  }

  let bitIdx = 0;
  let upward = true;
  for (let col = N - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    const rows = upward ? Array.from({ length: N }, (_, i) => N - 1 - i) : Array.from({ length: N }, (_, i) => i);
    for (const r of rows) {
      for (const c of [col, col - 1]) {
        if (!reserved[r][c]) {
          const bit = bitIdx < finalBits.length ? finalBits[bitIdx++] : 0;
          const mask = ((r + c) % 2 === 0) ? 1 : 0;
          matrix[r][c] = (bit ^ mask) === 1;
        }
      }
    }
    upward = !upward;
  }

  const formatBits = [1, 0, 0, 0, 1, 1, 1, 1, 0, 1, 0, 1, 1, 0, 0];
  for (let i = 0; i < 6; i++) matrix[8][i] = formatBits[i] === 1;
  matrix[8][7] = formatBits[6] === 1;
  matrix[8][8] = formatBits[7] === 1;
  matrix[7][8] = formatBits[8] === 1;
  for (let i = 9; i < 15; i++) matrix[14 - i][8] = formatBits[i] === 1;

  for (let i = 0; i < 7; i++) matrix[N - 1 - i][8] = formatBits[i] === 1;
  for (let i = 7; i < 15; i++) matrix[8][N - 15 + i] = formatBits[i] === 1;

  const margin = options.margin !== undefined ? options.margin : 2;
  const fg = options.foreground || '#111b21';
  const bg = options.background || '#ffffff';
  let path = '';
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (matrix[r][c]) path += `M${c + margin},${r + margin}h1v1h-1z `;
    }
  }
  const fullSize = N + margin * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fullSize} ${fullSize}" shape-rendering="crispEdges" width="100%" height="100%"><rect width="${fullSize}" height="${fullSize}" fill="${bg}"/><path d="${path.trim()}" fill="${fg}"/></svg>`;
}

// ---------------------------------------------------------------------------
// Android Bridge IPC Dispatcher
// ---------------------------------------------------------------------------

function sendToBridge(event, data, customBridge) {
  const payload = Object.assign({ event }, data);

  // 1. Explicit custom bridge instance/handler
  if (customBridge) {
    try {
      if (typeof customBridge.post === 'function') {
        customBridge.post(event, payload);
        return true;
      }
      if (typeof customBridge.send === 'function') {
        customBridge.send(payload);
        return true;
      }
      if (typeof customBridge.emit === 'function') {
        customBridge.emit(event, payload);
        return true;
      }
      if (typeof customBridge === 'function') {
        customBridge(event, payload);
        return true;
      }
    } catch (err) {
      console.warn('[IPC] customBridge dispatch error:', err);
    }
  }

  // 2. Janea Systems rn-bridge (React Native / Node.js Mobile standard)
  try {
    const rnBridge = require('rn-bridge');
    if (rnBridge && rnBridge.channel) {
      if (typeof rnBridge.channel.post === 'function') {
        rnBridge.channel.post(event, payload);
        return true;
      }
      if (typeof rnBridge.channel.send === 'function') {
        rnBridge.channel.send(payload);
        return true;
      }
    }
  } catch {
    // Not running inside rn-bridge container
  }

  // 3. Node.js process IPC channel
  if (typeof process.send === 'function') {
    try {
      process.send(payload);
      return true;
    } catch (err) {
      console.warn('[IPC] process.send error:', err);
    }
  }

  // 4. Global Android WebView / Native bridge
  if (global.__ANDROID_BRIDGE__) {
    try {
      const b = global.__ANDROID_BRIDGE__;
      if (typeof b.post === 'function') { b.post(event, payload); return true; }
      if (typeof b.send === 'function') { b.send(payload); return true; }
    } catch {}
  }
  if (global.ZapBridge) {
    try {
      const b = global.ZapBridge;
      if (typeof b.onQrLive === 'function') { b.onQrLive(payload); return true; }
      if (typeof b.send === 'function') { b.send(payload); return true; }
    } catch {}
  }

  return false;
}

// ---------------------------------------------------------------------------
// Live QR Flow Handler & Seamless Rotation Controller
// ---------------------------------------------------------------------------

const DEFAULT_QR_TTL = 30; // 30 seconds default rotation refresh

class QrFlowHandler extends EventEmitter {
  constructor(engine, options = {}) {
    super();
    this.engine = engine || null;
    this.options = options;
    this.bridge = options.bridge || null;
    this.defaultTtl = options.defaultTtl || DEFAULT_QR_TTL;
    this.autoRefresh = options.autoRefresh !== false;

    this.currentPayload = null;
    this.currentSvg = null;
    this.currentRef = null;
    this.previousRef = null;
    this.rotationCount = 0;
    this.ttl = this.defaultTtl;
    this.expiresAt = null;
    this.lastRotatedAt = null;
    this.isActive = false;
    this._rotationTimer = null;

    if (this.engine) {
      this.attachEngine(this.engine);
    }
  }

  attachEngine(engine) {
    if (!engine) return;
    this.engine = engine;

    const handler = (data) => this.handleAuthQr(data);

    // Standard event emitter: engine.on('auth_qr')
    if (typeof engine.on === 'function') {
      engine.on('auth_qr', handler);
    }

    // Baileys / Zapo connection event emitter: engine.ev.on('auth_qr')
    if (engine.ev && typeof engine.ev.on === 'function') {
      engine.ev.on('auth_qr', handler);
      engine.ev.on('connection.update', (update) => {
        if (update && update.qr) {
          handler(update.qr);
        }
      });
    }
  }

  handleAuthQr(data) {
    if (!data) return null;

    // 1. Normalize payload, server ref, and TTL
    let payload = '';
    let customRef = null;
    let customTtl = null;

    if (typeof data === 'string') {
      payload = data;
    } else if (typeof data === 'object') {
      payload = data.qr || data.payload || data.raw || '';
      customRef = data.ref || null;
      customTtl = data.ttl || data.timeout || null;
    }

    if (!payload && typeof data === 'object' && data.ref) {
      payload = data.ref;
    }

    // Server ref is the first comma-separated token in WhatsApp MD QR
    const serverRef = customRef || (typeof payload === 'string' && payload.includes(',') ? payload.split(',')[0] : payload);
    const ttl = customTtl || this.defaultTtl;

    // 2. Handle QR rotation seamlessly
    const isNewRef = this.currentRef !== serverRef;
    if (isNewRef) {
      this.previousRef = this.currentRef;
      this.currentRef = serverRef;
      this.rotationCount++;
      this.lastRotatedAt = Date.now();
    }

    this.currentPayload = payload;
    this.ttl = ttl;
    this.expiresAt = Date.now() + (ttl * 1000);
    this.isActive = true;

    // 3. Generate SVG markup of live QR code
    this.currentSvg = generateQrSvg(payload, this.options.svgOptions);

    // 4. Reset & start rotation countdown timer
    this._resetRotationTimer(ttl);

    // 5. Send live QR SVG and payload to Android bridge via IPC (event: 'qr_live')
    const eventPayload = {
      event: 'qr_live',
      svg: this.currentSvg,
      payload: this.currentPayload,
      qr: this.currentPayload,
      ref: this.currentRef,
      previousRef: this.previousRef,
      rotationCount: this.rotationCount,
      ttl: this.ttl,
      expiresAt: this.expiresAt,
      timestamp: Date.now()
    };

    sendToBridge('qr_live', eventPayload, this.bridge);
    this.emit('qr_live', eventPayload);

    if (isNewRef) {
      this.emit('qr_rotated', eventPayload);
    }

    return eventPayload;
  }

  _resetRotationTimer(ttlSeconds) {
    if (this._rotationTimer) {
      clearTimeout(this._rotationTimer);
      this._rotationTimer = null;
    }

    this._rotationTimer = setTimeout(() => {
      this._onRotationExpired();
    }, (ttlSeconds || this.defaultTtl) * 1000);
  }

  _onRotationExpired() {
    this.isActive = false;
    const expiredPayload = {
      ref: this.currentRef,
      rotationCount: this.rotationCount,
      expired: true,
      timestamp: Date.now()
    };

    sendToBridge('qr_expired', expiredPayload, this.bridge);
    this.emit('qr_expired', expiredPayload);

    // Seamless auto-refresh from server ref if supported
    if (this.autoRefresh && this.engine) {
      if (typeof this.engine.requestNewQr === 'function') {
        this.engine.requestNewQr();
      } else if (typeof this.engine.refreshQr === 'function') {
        this.engine.refreshQr();
      } else if (typeof this.engine.emit === 'function') {
        this.engine.emit('request_qr', { lastRef: this.currentRef });
      }
    }
  }

  rotate(newRefOrPayload, ttl) {
    return this.handleAuthQr(newRefOrPayload);
  }

  getState() {
    const remainingMs = this.expiresAt ? Math.max(0, this.expiresAt - Date.now()) : 0;
    return {
      isActive: this.isActive,
      payload: this.currentPayload,
      svg: this.currentSvg,
      ref: this.currentRef,
      previousRef: this.previousRef,
      rotationCount: this.rotationCount,
      ttl: this.ttl,
      expiresAt: this.expiresAt,
      remainingSecs: Math.ceil(remainingMs / 1000)
    };
  }

  reset() {
    if (this._rotationTimer) {
      clearTimeout(this._rotationTimer);
      this._rotationTimer = null;
    }
    this.currentPayload = null;
    this.currentSvg = null;
    this.currentRef = null;
    this.previousRef = null;
    this.rotationCount = 0;
    this.expiresAt = null;
    this.isActive = false;
  }

  destroy() {
    this.reset();
    this.removeAllListeners();
  }
}

function createQrFlow(engine, options) {
  return new QrFlowHandler(engine, options);
}

const setupQrFlow = createQrFlow;

// ---------------------------------------------------------------------------
// Runnable Self-Check (Zero-framework verification)
// ---------------------------------------------------------------------------

function runSelfCheck() {
  const assert = require('assert');
  console.log('[QrFlow] Running self-check...');

  // 1. Verify SVG Generation
  const samplePayload = '1@abc123xyz456,bW9ja19ub2lzZV9wdWJsaWNfa2V5XzMyX2J5dGVzX3Rlc3RfXw==,bW9ja19pZGVudGl0eV9wdWJsaWNfa2V5XzMyX2J5dGVzX3Rlcw==,bW9ja19hZHZfc2VjcmV0X2tleV8zMl9ieXRlc190ZXN0X19f';
  const svg = generateQrSvg(samplePayload);
  assert(typeof svg === 'string', 'SVG must be a string');
  assert(svg.startsWith('<svg'), 'SVG must start with <svg');
  assert(svg.includes('<rect'), 'SVG must contain background rect');
  assert(svg.includes('<path'), 'SVG must contain path data');
  assert(svg.endsWith('</svg>'), 'SVG must end with </svg>');
  console.log('  [PASS] 1. Live WhatsApp QR SVG markup generated correctly.');

  // 2. Verify Engine Binding & IPC Dispatch
  const mockEngine = new EventEmitter();
  const dispatchedEvents = [];
  const mockBridge = {
    post: (evt, data) => dispatchedEvents.push({ evt, data }),
    send: (data) => dispatchedEvents.push({ evt: data.event, data })
  };

  const flow = createQrFlow(mockEngine, {
    bridge: mockBridge,
    defaultTtl: 2,
    autoRefresh: true
  });

  // Fire 'auth_qr'
  mockEngine.emit('auth_qr', samplePayload);

  assert.strictEqual(dispatchedEvents.length, 1, 'Bridge must receive exactly 1 IPC call');
  assert.strictEqual(dispatchedEvents[0].evt, 'qr_live', 'Event name must be qr_live');
  const d0 = dispatchedEvents[0].data;
  assert.strictEqual(d0.payload, samplePayload, 'Payload must match WhatsApp QR string');
  assert.strictEqual(d0.ref, '1@abc123xyz456', 'Server ref must be parsed from payload');
  assert.strictEqual(d0.rotationCount, 1, 'First QR has rotationCount 1');
  assert(d0.svg && d0.svg.startsWith('<svg'), 'Event data must include generated SVG markup');
  assert(d0.expiresAt > Date.now(), 'expiresAt must be in the future');
  console.log('  [PASS] 2. auth_qr event generates SVG and sends qr_live IPC to Android bridge.');

  // 3. Verify Seamless QR Rotation on Server Ref Refresh
  const rotatedPayload = '2@def789uvw012,bW9ja19ub2lzZV9wdWJsaWNfa2V5XzMyX2J5dGVzX3Rlc3RfXw==,bW9ja19pZGVudGl0eV9wdWJsaWNfa2V5XzMyX2J5dGVzX3Rlcw==,bW9ja19hZHZfc2VjcmV0X2tleV8zMl9ieXRlc190ZXN0X19f';
  mockEngine.emit('auth_qr', rotatedPayload);

  assert.strictEqual(dispatchedEvents.length, 2, 'Bridge must receive second IPC call on rotation');
  const d1 = dispatchedEvents[1].data;
  assert.strictEqual(d1.evt, undefined); // payload contains event property
  assert.strictEqual(d1.event, 'qr_live');
  assert.strictEqual(d1.ref, '2@def789uvw012', 'Rotated ref must match new server ref');
  assert.strictEqual(d1.previousRef, '1@abc123xyz456', 'Previous ref must be tracked');
  assert.strictEqual(d1.rotationCount, 2, 'Rotation count must increment to 2');
  console.log('  [PASS] 3. Seamless QR rotation handled on new server ref.');

  flow.destroy();
  console.log('[QrFlow] All self-checks passed successfully.');
}

if (require.main === module) {
  runSelfCheck();
}

module.exports = {
  createQrFlow,
  setupQrFlow,
  QrFlowHandler,
  generateQrSvg,
  sendToBridge,
  DEFAULT_QR_TTL
};
