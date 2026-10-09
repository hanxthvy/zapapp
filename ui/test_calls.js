// [xihanzu-NR]
const assert = require('assert');
const fs = require('fs');

console.log('Running Calls Tab & Synchronization verification tests...');

// 1. Verify index.html does not contain mock calls or contacts
const htmlPaths = [
  '/var/www/zapapp/ui/index.html',
  '/var/www/zapapp/android/app/src/main/assets/ui/index.html'
];

htmlPaths.forEach(function (htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert(!html.includes('Alex Mercer'), `Mock call 'Alex Mercer' must NOT exist in ${htmlPath}`);
  assert(!html.includes('Incoming voice call'), `Mock text 'Incoming voice call' must NOT exist in ${htmlPath}`);
  assert(html.includes('id="calls-list-group"'), `calls-list-group must exist in ${htmlPath}`);
  assert(html.includes('id="empty-calls-state"'), `empty-calls-state must exist in ${htmlPath}`);
  assert(html.includes('// [xihanzu-NR]'), `Watermark must exist in ${htmlPath}`);
  console.log(`  [PASS] HTML assertion verified for ${htmlPath}`);
});

// 2. Minimal DOM environment for app.js ZapCalls verification
const elementsById = {};
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
}

class MockElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.classList = new MockClassList();
    this.attributes = {};
    this.style = {};
    this.listeners = {};
    this.id = '';
    this._innerHTML = '';
  }
  addEventListener(ev, fn) {
    if (!this.listeners[ev]) this.listeners[ev] = [];
    this.listeners[ev].push(fn);
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(val) {
    this._innerHTML = val;
    this.children = [];
  }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k] || null; }
  appendChild(child) {
    this.children.push(child);
    child.parentElement = this;
    return child;
  }
  querySelectorAll(sel) {
    const res = [];
    function scan(el) {
      for (const ch of el.children) {
        if (sel === '.list-item' && ch.className === 'list-item') res.push(ch);
        scan(ch);
      }
    }
    scan(this);
    return res;
  }
  remove() {
    if (this.parentElement) {
      const idx = this.parentElement.children.indexOf(this);
      if (idx !== -1) this.parentElement.children.splice(idx, 1);
    }
  }
}

const mockCallsGroup = new MockElement('div');
mockCallsGroup.id = 'calls-list-group';
elementsById['calls-list-group'] = mockCallsGroup;

const mockEmptyState = new MockElement('div');
mockEmptyState.id = 'empty-calls-state';
elementsById['empty-calls-state'] = mockEmptyState;
mockCallsGroup.appendChild(mockEmptyState);

global.window = {
  addEventListener: () => {},
  localStorage: { getItem: () => 'true', setItem: () => {}, removeItem: () => {} }
};
global.document = {
  getElementById: (id) => elementsById[id] || new MockElement('div'),
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: (tag) => new MockElement(tag),
  addEventListener: () => {},
  readyState: 'complete'
};
global.localStorage = global.window.localStorage;

// Load app.js
require('/var/www/zapapp/ui/js/app.js');

// 3. Test ZapCalls Public API
assert(typeof global.window.ZapCalls === 'object', 'window.ZapCalls must be an object');
assert(typeof global.window.ZapCalls.syncCalls === 'function', 'syncCalls must be function');
assert(typeof global.window.ZapCalls.addCall === 'function', 'addCall must be function');
assert(typeof global.window.ZapCalls.getCalls === 'function', 'getCalls must be function');
console.log('  [PASS] ZapCalls public API exported');

// 4. Test syncCalls with mock empty payload -> empty state visible
global.window.ZapCalls.syncCalls([]);
assert.strictEqual(mockEmptyState.style.display, 'block', 'Empty state must be visible on empty call log');
assert.strictEqual(global.window.ZapCalls.getCalls().length, 0, 'Calls count should be 0');
console.log('  [PASS] Empty calls synchronization verified');

// 5. Test syncCalls with real incoming call
const realCalls = [
  { id: 'call_1', name: 'Budi Santoso', time: '14:20', incoming: true, isVideo: false },
  { id: 'call_2', name: 'Siti Rahma', time: '12:05', status: 'missed', isVideo: true }
];
global.window.ZapCalls.syncCalls(realCalls);
assert.strictEqual(mockEmptyState.style.display, 'none', 'Empty state must be hidden when real calls exist');
assert.strictEqual(mockCallsGroup.querySelectorAll('.list-item').length, 2, 'Two call items must be rendered');
assert.strictEqual(global.window.ZapCalls.getCalls().length, 2, 'Store must contain 2 calls');
console.log('  [PASS] Real calls synchronization and rendering verified');

// 6. Test addCall with new incoming call
global.window.ZapCalls.addCall({ id: 'call_3', name: 'Kantor Pusat', time: 'Just now', incoming: true, isVideo: false });
assert.strictEqual(global.window.ZapCalls.getCalls().length, 3, 'Store must contain 3 calls after addCall');
assert.strictEqual(mockCallsGroup.querySelectorAll('.list-item').length, 3, 'Three call items must be rendered');
console.log('  [PASS] addCall live update verified');

console.log('ALL CALLS TESTS PASSED CLEANLY.');
