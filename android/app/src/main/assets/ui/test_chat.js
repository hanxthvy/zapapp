// [xihanzu-NR]
const assert = require('assert');
const fs = require('fs');

// Minimal DOM mock for Node.js
class MockClassList {
  constructor() { this.classes = new Set(); }
  add(c) { this.classes.add(c); }
  remove(c) { this.classes.delete(c); }
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
    this._className = '';
    this.attributes = {};
    this.style = {};
    this.listeners = {};
    this._innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.id = '';
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(val) {
    this._innerHTML = val;
    this.children = [];
    if (typeof val !== 'string') return;
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
  get className() { return Array.from(this.classList.classes).join(' '); }
  set className(val) {
    this.classList.classes.clear();
    if (val) val.split(' ').filter(Boolean).forEach(c => this.classList.add(c));
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] || null; }
  appendChild(child) {
    this.children.push(child);
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
    const list = this.listeners[event.type || event] || [];
    list.forEach(fn => fn(event));
  }
  click() {
    this.dispatchEvent({ type: 'click', stopPropagation: () => {} });
  }
  focus() {}
  scrollTo() {}
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  querySelectorAll(sel) {
    const matches = [];
    function search(node) {
      let isMatch = false;
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        if (node.classList && node.classList.contains(cls)) isMatch = true;
      } else if (sel.startsWith('#')) {
        const id = sel.slice(1);
        if (node.id === id) isMatch = true;
      } else if (sel.startsWith('[') && sel.endsWith(']')) {
        const raw = sel.slice(1, -1);
        const [k, v] = raw.split('=');
        const cleanV = v ? v.replace(/"/g, '') : null;
        if (cleanV !== null && node.getAttribute(k) === cleanV) isMatch = true;
        else if (cleanV === null && node.getAttribute(k) !== null) isMatch = true;
      }
      if (isMatch) matches.push(node);
      if (node.children) node.children.forEach(search);
    }
    search(this);
    return matches;
  }
}

// Global window and document mock
const elementsById = {};
const rootDoc = new MockElement('body');

global.window = {
  addEventListener: (evt, fn) => {
    if (!global.window._listeners) global.window._listeners = {};
    if (!global.window._listeners[evt]) global.window._listeners[evt] = [];
    global.window._listeners[evt].push(fn);
  },
  dispatchEvent: (evt) => {
    const list = (global.window._listeners && global.window._listeners[evt.type]) || [];
    list.forEach(fn => fn(evt));
  },
  open: (url) => { global.window._lastOpenedUrl = url; }
};

global.document = {
  readyState: 'complete',
  body: rootDoc,
  createElement: (tag) => new MockElement(tag),
  getElementById: (id) => elementsById[id] || null,
  querySelectorAll: (sel) => rootDoc.querySelectorAll(sel)
};

global.navigator = {
  clipboard: {
    writeText: async (text) => { global.navigator._copiedText = text; }
  }
};

global.requestAnimationFrame = (cb) => cb();

// Mock Bridge for Android
global.window.ZapBridge = {
  calls: [],
  sendMessage: (payload) => { global.window.ZapBridge.calls.push({ action: 'sendMessage', payload: JSON.parse(payload) }); },
  onQuickReplyClick: (payload) => { global.window.ZapBridge.calls.push({ action: 'onQuickReplyClick', payload: JSON.parse(payload) }); },
  openUrl: (payload) => { global.window.ZapBridge.calls.push({ action: 'openUrl', payload: JSON.parse(payload) }); },
  copyToClipboard: (payload) => { global.window.ZapBridge.calls.push({ action: 'copyToClipboard', payload: JSON.parse(payload) }); },
  onChatOpened: (payload) => { global.window.ZapBridge.calls.push({ action: 'onChatOpened', payload: JSON.parse(payload) }); }
};

// Create app container
const appEl = new MockElement('div');
appEl.id = 'app';
elementsById['app'] = appEl;
rootDoc.appendChild(appEl);

// Load chat.js script
const chatJsCode = fs.readFileSync('/var/www/zapapp/ui/js/chat.js', 'utf8');
eval(chatJsCode);

// Register dynamic elements in elementsById for getElementById lookup
function registerElements(el) {
  if (el.id) elementsById[el.id] = el;
  if (el.children) el.children.forEach(registerElements);
}
registerElements(appEl);

console.log('Running chat.js tests...');

// 1. Verify ZapChat object exists
assert(typeof window.ZapChat === 'object', 'window.ZapChat must be an object');
assert(typeof window.ZapChat.openChat === 'function', 'openChat must be function');
assert(typeof window.ZapChat.sendMessage === 'function', 'sendMessage must be function');
assert(typeof window.ZapChat.receiveMessage === 'function', 'receiveMessage must be function');
assert(typeof window.ZapChat.updateMessageStatus === 'function', 'updateMessageStatus must be function');
console.log('  [PASS] ZapChat API exported');

// 2. Open chat
window.ZapChat.openChat({ id: 'engineering_core', name: 'Engineering Core', status: 'online' });
registerElements(appEl);
const chatView = document.getElementById('chat-view');
assert(chatView && chatView.classList.contains('active'), 'Chat view must be active');
const msgs = window.ZapChat.getMessages('engineering_core');
assert(msgs.length >= 4, 'Should load initial seed messages');
console.log('  [PASS] openChat successfully renders view');

// 3. Test sending message
const prevCount = msgs.length;
window.ZapChat.sendMessage('Hello from integration test');
assert.strictEqual(window.ZapChat.getMessages('engineering_core').length, prevCount + 1, 'Message must be appended to store');
const sentBridgeCall = window.ZapBridge.calls.find(c => c.action === 'sendMessage');
assert(sentBridgeCall, 'Native bridge sendMessage must be invoked');
assert.strictEqual(sentBridgeCall.payload.text, 'Hello from integration test');
console.log('  [PASS] sendMessage outbound flow and bridge dispatch');

// 4. Test Native Flow Buttons
const testMsgWithBtns = {
  id: 'msg_test_btns',
  chatId: 'engineering_core',
  fromMe: false,
  text: 'Action required',
  timestamp: Date.now(),
  status: 'read',
  buttons: [
    { type: 'quick_reply', display_text: 'Ack Now', id: 'ack_1' },
    { type: 'cta_url', display_text: 'Open Link', url: 'https://test.zapapp/action' },
    { type: 'cta_copy', display_text: 'Copy Pass', copy_code: 'TEST-SECRET-123' }
  ]
};
window.ZapChat.receiveMessage(testMsgWithBtns);
const receivedMsg = window.ZapChat.getMessages('engineering_core').find(m => m.id === 'msg_test_btns');
assert(receivedMsg, 'Received message must be stored');
console.log('  [PASS] receiveMessage inbound with Native Flow buttons');

// 5. Test Status Update
window.ZapChat.updateMessageStatus('msg_104', 'read');
const msg104 = window.ZapChat.getMessages('engineering_core').find(m => m.id === 'msg_104');
assert.strictEqual(msg104.status, 'read', 'Status should be updated to read');
console.log('  [PASS] updateMessageStatus updates tick to read');

// 6. Test Android global hooks
assert(typeof window.onReceiveMessage === 'function', 'window.onReceiveMessage must exist');
assert(typeof window.onMessageStatusUpdate === 'function', 'window.onMessageStatusUpdate must exist');
window.onReceiveMessage(JSON.stringify({
  id: 'msg_from_android_hook',
  chatId: 'engineering_core',
  fromMe: false,
  text: 'Pushed via Android evaluateJavascript',
  timestamp: Date.now()
}));
const hookedMsg = window.ZapChat.getMessages('engineering_core').find(m => m.id === 'msg_from_android_hook');
assert(hookedMsg, 'Android hook message must be received');
console.log('  [PASS] Android WebView global callbacks verified');

console.log('ALL TESTS PASSED CLEANLY.');
