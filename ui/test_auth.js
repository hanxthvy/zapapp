// [xihanzu-NR]
const assert = require('assert');
const fs = require('fs');

// Global element registry for getElementById lookup
const elementsById = {};

class MockClassList {
  constructor() { this.classes = new Set(); }
  add(c) { if (c) this.classes.add(c); }
  remove(c) { if (c) this.classes.delete(c); }
  toggle(c, force) {
    if (force !== undefined) {
      if (force) this.classes.add(c); else this.classes.delete(c);
      return force;
    }
    if (this.classes.has(c)) { this.classes.delete(c); return false; }
    this.classes.add(c); return true;
  }
  contains(c) { return this.classes.has(c); }
}

class MockElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.classList = new MockClassList();
    this.attributes = {};
    this.style = {};
    this.listeners = {};
    this._innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.id = '';
    this.disabled = false;
  }

  get className() { return Array.from(this.classList.classes).join(' '); }
  set className(val) {
    this.classList.classes.clear();
    if (val) val.split(' ').filter(Boolean).forEach(c => this.classList.add(c));
  }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(val) {
    this._innerHTML = val;
    this.children = [];
    if (typeof val !== 'string') return;

    // Parse child tags and IDs to populate MockElement tree
    const tagRegex = /<([a-zA-Z0-9\-]+)([^>]*)>/g;
    let match;
    while ((match = tagRegex.exec(val)) !== null) {
      const tag = match[1];
      const attrsStr = match[2];
      if (tag.startsWith('/')) continue;

      const child = new MockElement(tag);
      const idMatch = attrsStr.match(/id=["']([^"']+)["']/);
      if (idMatch) {
        child.id = idMatch[1];
        elementsById[child.id] = child;
      }
      const classMatch = attrsStr.match(/class=["']([^"']+)["']/);
      if (classMatch) {
        child.className = classMatch[1];
      }
      this.children.push(child);
    }
  }

  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] || null; }

  appendChild(child) {
    this.children.push(child);
    if (child.id) elementsById[child.id] = child;
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) this.children.splice(idx, 1);
    return child;
  }

  addEventListener(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  dispatchEvent(event) {
    const type = event.type || event;
    const list = this.listeners[type] || [];
    list.forEach(fn => fn(event));
  }

  click() {
    this.dispatchEvent({ type: 'click', stopPropagation: () => {} });
  }

  focus() {}

  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }

  querySelectorAll(sel) {
    const matches = [];
    const search = (node) => {
      let isMatch = false;
      if (sel.startsWith('#')) {
        if (node.id === sel.slice(1)) isMatch = true;
      } else if (sel.startsWith('.')) {
        if (node.classList && node.classList.contains(sel.slice(1))) isMatch = true;
      } else if (sel.startsWith('[') && sel.endsWith(']')) {
        const raw = sel.slice(1, -1);
        const [k, v] = raw.split('=');
        const cleanV = v ? v.replace(/["']/g, '') : null;
        if (cleanV !== null && node.getAttribute(k) === cleanV) isMatch = true;
        else if (cleanV === null && node.getAttribute(k) !== null) isMatch = true;
      }
      if (isMatch) matches.push(node);
      if (node.children) node.children.forEach(search);
    };

    this.children.forEach(search);
    return matches;
  }
}

// Global window and document mock
const rootDoc = new MockElement('body');

global.window = {
  _listeners: {},
  addEventListener: (evt, fn) => {
    if (!global.window._listeners[evt]) global.window._listeners[evt] = [];
    global.window._listeners[evt].push(fn);
  },
  dispatchEvent: (evt) => {
    const list = global.window._listeners[evt.type] || [];
    list.forEach(fn => fn(evt));
  }
};

global.document = {
  readyState: 'complete',
  body: rootDoc,
  createElement: (tag) => new MockElement(tag),
  getElementById: (id) => elementsById[id] || null,
  querySelectorAll: (sel) => rootDoc.querySelectorAll(sel)
};

const mockNavigator = {
  clipboard: {
    writeText: async (text) => { mockNavigator._copiedText = text; }
  }
};
Object.defineProperty(global, 'navigator', { value: mockNavigator, configurable: true, writable: true });

// Mock Bridge for Android
global.window.ZapBridge = {
  calls: [],
  onRequestQr: (payload) => { global.window.ZapBridge.calls.push({ action: 'onRequestQr', payload: JSON.parse(payload) }); },
  onRequestPairingCode: (payload) => { global.window.ZapBridge.calls.push({ action: 'onRequestPairingCode', payload: JSON.parse(payload) }); },
  onPairingStateChanged: (payload) => { global.window.ZapBridge.calls.push({ action: 'onPairingStateChanged', payload: JSON.parse(payload) }); },
  onPairingCompleted: (payload) => { global.window.ZapBridge.calls.push({ action: 'onPairingCompleted', payload: JSON.parse(payload) }); },
  copyToClipboard: (payload) => { global.window.ZapBridge.calls.push({ action: 'copyToClipboard', payload: JSON.parse(payload) }); },
  onSyncProgress: (payload) => { global.window.ZapBridge.calls.push({ action: 'onSyncProgress', payload: JSON.parse(payload) }); }
};

// Create app container
const appEl = new MockElement('div');
appEl.id = 'app';
elementsById['app'] = appEl;
rootDoc.appendChild(appEl);

// Load auth.js script
const authJsCode = fs.readFileSync('/var/www/zapapp/ui/js/auth.js', 'utf8');
eval(authJsCode);

function registerRecursive(el) {
  if (el.id) elementsById[el.id] = el;
  if (el.children) el.children.forEach(registerRecursive);
}
registerRecursive(appEl);

console.log('Running auth.js pairing screen tests...');

// 1. Verify ZapAuth object exists
assert(typeof window.ZapAuth === 'object', 'window.ZapAuth must be an object');
assert(typeof window.ZapAuth.open === 'function', 'open must be function');
assert(typeof window.ZapAuth.close === 'function', 'close must be function');
assert(typeof window.ZapAuth.setState === 'function', 'setState must be function');
assert(typeof window.ZapAuth.setQrCode === 'function', 'setQrCode must be function');
assert(typeof window.ZapAuth.submitPhoneNumber === 'function', 'submitPhoneNumber must be function');
assert(typeof window.ZapAuth.setPairingCode === 'function', 'setPairingCode must be function');
assert(typeof window.ZapAuth.startConnecting === 'function', 'startConnecting must be function');
assert(typeof window.ZapAuth.setPaired === 'function', 'setPaired must be function');
assert(typeof window.ZapAuth.startSyncing === 'function', 'startSyncing must be function');
console.log('  [PASS] 1. ZapAuth public API exported');

// 2. Open pairing screen in QR mode
window.ZapAuth.open('qr');
registerRecursive(appEl);
assert.strictEqual(window.ZapAuth.isOpen(), true, 'ZapAuth should be open');
const pairingView = document.getElementById('pairing-view');
assert(pairingView && pairingView.classList.contains('active'), 'Pairing view must have active class');
const qrSection = document.getElementById('pairing-section-qr');
assert(qrSection && qrSection.classList.contains('active'), 'QR section must be active');
console.log('  [PASS] 2. ZapAuth.open renders pairing overlay and QR section');

// 3. Test QR code generation and SVG rendering
const testPayload = 'zap_test_ref_12345,NOISE_KEY_PUB_TEST,IDENTITY_KEY_PUB_TEST';
window.ZapAuth.setQrCode(testPayload, 30);
const qrContainer = document.getElementById('qr-code-svg-container');
assert(qrContainer && qrContainer.innerHTML.includes('<svg'), 'QR container must contain rendered SVG');
assert(qrContainer.innerHTML.includes('viewBox='), 'QR SVG must have viewBox attribute');
assert.strictEqual(window.ZapAuth.getState().qrTimerRemaining, 30, 'QR timer must initialize to 30s');
console.log('  [PASS] 3. QR Code SVG rendered with countdown timer');

// 4. Test Switching to Phone Number Mode
window.ZapAuth.switchMethod('phone');
registerRecursive(appEl);
const phoneSection = document.getElementById('pairing-section-phone-input');
assert(phoneSection && phoneSection.classList.contains('active'), 'Phone input section must be active');
assert.strictEqual(window.ZapAuth.getState().method, 'phone', 'Method must be phone');
console.log('  [PASS] 4. switchMethod activates phone input section');

// 5. Test Phone Number Validation and Submission
const phoneInput = document.getElementById('phone-number-input');
const phoneSubmitBtn = document.getElementById('phone-submit-btn');
phoneInput.value = '555';
phoneInput.dispatchEvent({ type: 'input' });
assert.strictEqual(phoneSubmitBtn.disabled, true, 'Submit button must be disabled for short input');

phoneInput.value = '5550192834';
phoneInput.dispatchEvent({ type: 'input' });
assert.strictEqual(phoneSubmitBtn.disabled, false, 'Submit button must be enabled for >= 7 digits');

window.ZapAuth.submitPhoneNumber('+1 5550192834');
registerRecursive(appEl);
const pairingCodeSection = document.getElementById('pairing-section-pairing-code');
assert(pairingCodeSection && pairingCodeSection.classList.contains('active'), 'Pairing code section must be active');
const currentPairingCode = window.ZapAuth.getState().pairingCode;
assert(currentPairingCode && currentPairingCode.length === 8, '8-character pairing code must be generated');
console.log('  [PASS] 5. Phone number submitted and 8-digit code generated:', currentPairingCode);

// 6. Test 8-digit pairing code box display
window.ZapAuth.setPairingCode('ABCD2345', 160);
const char0 = document.getElementById('code-char-0');
const char7 = document.getElementById('code-char-7');
assert.strictEqual(char0.textContent, 'A', 'Character box 0 must show A');
assert.strictEqual(char7.textContent, '5', 'Character box 7 must show 5');
console.log('  [PASS] 6. 8-digit pairing code rendered in segmented boxes');

// 7. Test Copy Code Action
const copyBtn = document.getElementById('code-copy-btn');
copyBtn.click();
assert.strictEqual(global.navigator._copiedText, 'ABCD-2345', 'Formatted code must be copied to clipboard');
const bridgeCopyCall = window.ZapBridge.calls.find(c => c.action === 'copyToClipboard');
assert(bridgeCopyCall, 'Native bridge copyToClipboard must be called');
assert.strictEqual(bridgeCopyCall.payload.text, 'ABCD-2345', 'Bridge payload must match formatted code');
console.log('  [PASS] 7. Copy pairing code clipboard and bridge dispatch');

// 8. Test State Transitions: Connecting -> Paired -> Syncing chats -> Completed
// A) Connecting
window.ZapAuth.startConnecting();
registerRecursive(appEl);
assert.strictEqual(window.ZapAuth.getState().uiState, 'connecting', 'UI state must be connecting');
const titleEl = document.getElementById('transition-title');
assert(titleEl && titleEl.textContent.includes('Connecting'), 'Transition title must show Connecting');
console.log('  [PASS] 8A. State transition: Connecting');

// B) Paired
window.ZapAuth.setPaired({ name: 'Samsung Galaxy S24', id: 2 });
assert.strictEqual(window.ZapAuth.getState().uiState, 'paired', 'UI state must be paired');
assert(titleEl.textContent.includes('Paired'), 'Transition title must show Paired');
console.log('  [PASS] 8B. State transition: Paired');

// C) Syncing chats
window.ZapAuth.setState('syncing', { progress: 45, subtext: 'Syncing chats...' });
assert.strictEqual(window.ZapAuth.getState().uiState, 'syncing', 'UI state must be syncing');
const progressBar = document.getElementById('sync-progress-bar-fill');
assert.strictEqual(progressBar.style.width, '45%', 'Progress bar fill must be 45%');
console.log('  [PASS] 8C. State transition: Syncing chats');

// D) Completed
window.ZapAuth.setState('completed');
assert.strictEqual(window.ZapAuth.getState().uiState, 'completed', 'UI state must be completed');
const completedBridgeCall = window.ZapBridge.calls.find(c => c.action === 'onPairingCompleted');
assert(completedBridgeCall, 'onPairingCompleted must be dispatched to bridge');
console.log('  [PASS] 8D. State transition: Completed');

// 9. Test Android WebView Global Hooks
assert(typeof window.onPairingStateUpdate === 'function', 'window.onPairingStateUpdate must exist');
assert(typeof window.onQrReceived === 'function', 'window.onQrReceived must exist');
assert(typeof window.onPairingCodeReceived === 'function', 'window.onPairingCodeReceived must exist');
assert(typeof window.onSyncProgressUpdate === 'function', 'window.onSyncProgressUpdate must exist');

window.onPairingCodeReceived(JSON.stringify({ code: '77889900', ttl: 120 }));
assert.strictEqual(window.ZapAuth.getState().pairingCode, '77889900', 'Hook must update pairing code');

// Direct string invocations from Android WebView
window.onPairingCodeReceived('88990011');
assert.strictEqual(window.ZapAuth.getState().pairingCode, '88990011', 'Raw string code must update pairing code');

window.onQrReceived('2@live_qr_matrix_raw,key1,key2');
assert.strictEqual(window.ZapAuth.getState().qrPayload, '2@live_qr_matrix_raw,key1,key2', 'Raw string QR must update qrPayload');

window.onPairingStateUpdate('paired');
assert.strictEqual(window.ZapAuth.getState().uiState, 'paired', 'Direct paired state update must transition UI state to paired');

window.onSyncProgressUpdate(JSON.stringify({ progress: 85, subtext: 'Finalizing database...' }));
assert.strictEqual(window.ZapAuth.getState().syncProgress, 85, 'Hook must update sync progress');
console.log('  [PASS] 9. Android WebView inbound hooks verified');

// 10. Close pairing screen
window.ZapAuth.close();
assert.strictEqual(window.ZapAuth.isOpen(), false, 'ZapAuth should be closed');
assert(!pairingView.classList.contains('active'), 'Pairing view should not be active');
console.log('  [PASS] 10. ZapAuth.close cleans up and hides overlay');

console.log('\nALL 10 PAIRING SUITE TESTS PASSED CLEANLY.');
