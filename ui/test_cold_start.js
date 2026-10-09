// [xihanzu-NR]
// Runnable self-check for 'cold_start_auth_gate_flicker' defect fix in app.js
const assert = require('assert');
const fs = require('fs');

const APP_JS_PATH = '/var/www/zapapp/ui/js/app.js';
const appJsCode = fs.readFileSync(APP_JS_PATH, 'utf8');

// 1. Static assertion: the 50ms delayed setTimeout must no longer exist
assert(!appJsCode.includes('setTimeout(checkInitialAuth, 50)'),
  'FAIL: setTimeout(checkInitialAuth, 50) must be completely removed');

// 2. Static assertion: every switchTab('chats') in the init tail must sit behind
//    a zap_is_paired guard (never runs unconditionally at script evaluation)
const bottomSection = appJsCode.slice(appJsCode.lastIndexOf('window.ZapAppInit'));
const guardIdx = bottomSection.indexOf("localStorage.getItem('zap_is_paired')");
const switchIdx = bottomSection.indexOf("switchTab('chats')");
assert(guardIdx !== -1,
  'FAIL: init tail must guard on localStorage zap_is_paired');
assert(switchIdx === -1 || switchIdx > guardIdx,
  'FAIL: switchTab("chats") must be guarded by the pairing check, not unconditional');
assert(!bottomSection.includes('setTimeout(checkInitialAuth'),
  'FAIL: checkInitialAuth must not be deferred via setTimeout');

// 3. Static assertion: watermark present
assert(appJsCode.includes('// [xihanzu-NR]'),
  'FAIL: Watermark must be present');

// 4. Runtime simulation - Cold start with UNPAIRED state
function runColdStartSimulation(isPaired) {
  const listeners = {};
  const classesByElement = {
    'tab-chats': new Set(['tab-panel', 'active']),
    'tab-status': new Set(['tab-panel']),
    'tab-btn-chats': new Set(['tab-btn', 'active']),
    'tab-btn-status': new Set(['tab-btn'])
  };

  const panels = [
    {
      id: 'tab-chats',
      classList: {
        remove: (c) => classesByElement['tab-chats'].delete(c),
        toggle: (c, force) => force ? classesByElement['tab-chats'].add(c) : classesByElement['tab-chats'].delete(c),
        contains: (c) => classesByElement['tab-chats'].has(c)
      }
    },
    {
      id: 'tab-status',
      classList: {
        remove: (c) => classesByElement['tab-status'].delete(c),
        toggle: (c, force) => force ? classesByElement['tab-status'].add(c) : classesByElement['tab-status'].delete(c),
        contains: (c) => classesByElement['tab-status'].has(c)
      }
    }
  ];

  const buttons = [
    {
      getAttribute: (a) => a === 'data-tab' ? 'chats' : null,
      addEventListener: () => {},
      classList: {
        remove: (c) => classesByElement['tab-btn-chats'].delete(c),
        toggle: (c, force) => force ? classesByElement['tab-btn-chats'].add(c) : classesByElement['tab-btn-chats'].delete(c)
      }
    },
    {
      getAttribute: (a) => a === 'data-tab' ? 'status' : null,
      addEventListener: () => {},
      classList: {
        remove: (c) => classesByElement['tab-btn-status'].delete(c),
        toggle: (c, force) => force ? classesByElement['tab-btn-status'].add(c) : classesByElement['tab-btn-status'].delete(c)
      }
    }
  ];

  let openCalledWith = null;
  const mockZapAuth = {
    open: (mode) => { openCalledWith = mode; }
  };

  const timeoutsScheduled = [];
  const origSetTimeout = global.setTimeout;
  global.setTimeout = (fn, delay) => {
    timeoutsScheduled.push({ fn, delay });
    return 1;
  };

  global.window = {
    ZapAuth: mockZapAuth,
    addEventListener: () => {}
  };

  const bannerEl = {
    style: {},
    innerHTML: '',
    addEventListener: () => {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    querySelectorAll: () => []
  };

  global.localStorage = {
    getItem: (key) => key === 'zap_is_paired' ? (isPaired ? 'true' : null) : null,
    setItem: () => {},
    removeItem: () => {}
  };

  global.document = {
    readyState: 'loading',
    querySelectorAll: (sel) => {
      if (sel === '.tab-btn') return buttons;
      if (sel === '.tab-panel') return panels;
      return [];
    },
    getElementById: (id) => {
      if (id === 'auth-prompt-banner') return bannerEl;
      const el = {
        style: {},
        innerHTML: '',
        addEventListener: () => {},
        classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
        querySelectorAll: () => []
      };
      if (id === 'tab-indicator') return el;
      if (id === 'fab-btn') return el;
      return null;
    },
    addEventListener: (evt, fn) => {
      listeners[evt] = fn;
    }
  };

  // Run app.js
  eval(appJsCode);

  global.setTimeout = origSetTimeout;

  return {
    classesByElement,
    openCalledWith,
    listeners,
    timeoutsScheduled,
    mockZapAuth,
    bannerEl,
    getOpenCalledWith: () => openCalledWith
  };
}

// Case A: Unpaired cold start
const unpairedRun = runColdStartSimulation(false);
assert(!unpairedRun.classesByElement['tab-chats'].has('active'),
  'FAIL: unauthenticated cold-start MUST NOT have active class on chats tab');
assert(!unpairedRun.classesByElement['tab-btn-chats'].has('active'),
  'FAIL: unauthenticated cold-start MUST NOT have active class on chats tab button');
assert.strictEqual(unpairedRun.timeoutsScheduled.filter(t => t.delay === 50).length, 0,
  'FAIL: MUST NOT schedule any 50ms setTimeout');
assert.strictEqual(unpairedRun.bannerEl.style.display, 'flex',
  'FAIL: unpaired cold-start MUST show the pairing banner');

// Trigger DOMContentLoaded
assert(typeof unpairedRun.listeners['DOMContentLoaded'] === 'function',
  'FAIL: DOMContentLoaded listener must be registered');
unpairedRun.listeners['DOMContentLoaded']();
assert.strictEqual(unpairedRun.getOpenCalledWith(), 'qr',
  'FAIL: ZapAuth.open("qr") must be called immediately on DOMContentLoaded');

// Case B: Paired cold start
const pairedRun = runColdStartSimulation(true);
assert(pairedRun.classesByElement['tab-chats'].has('active'),
  'FAIL: authenticated cold-start MUST activate chats tab');
assert.strictEqual(pairedRun.bannerEl.style.display, 'none',
  'FAIL: authenticated cold-start MUST hide the pairing banner at script evaluation (no flash)');

console.log('ALL VERIFICATIONS PASSED: cold_start_auth_gate_flicker fixed cleanly.');
