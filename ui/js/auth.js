// [xihanzu-NR]
(function () {
  'use strict';

  // ponytail: in-memory state and timer intervals; upgrade to Web Workers or Service Worker sync if background background tab throttling affects pairing timers.

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

  function generateQrSvg(text) {
    const cleanText = text || 'zapapp:pairing:empty';
    const utf8 = unescape(encodeURIComponent(cleanText));
    const byteData = [];
    for (let i = 0; i < utf8.length; i++) byteData.push(utf8.charCodeAt(i));

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
    const count = Math.min(byteData.length, spec.data - 3);
    addBits(count, 8);
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
      for (let ay of spec.align) {
        for (let ax of spec.align) {
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
    for (let cw of finalCodewords) {
      for (let i = 7; i >= 0; i--) finalBits.push((cw >> i) & 1);
    }

    let bitIdx = 0;
    let upward = true;
    for (let col = N - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      const rows = upward ? Array.from({ length: N }, (_, i) => N - 1 - i) : Array.from({ length: N }, (_, i) => i);
      for (let r of rows) {
        for (let c of [col, col - 1]) {
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

    let path = '';
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (matrix[r][c]) path += 'M' + (c + 2) + ',' + (r + 2) + 'h1v1h-1z ';
      }
    }
    const fullSize = N + 4;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + fullSize + ' ' + fullSize + '" shape-rendering="crispEdges" width="100%" height="100%"><rect width="' + fullSize + '" height="' + fullSize + '" fill="#ffffff"/><path d="' + path + '" fill="#111b21"/></svg>';
  }

  // ---------------------------------------------------------------------------
  // SVG Icons
  // ---------------------------------------------------------------------------

  const ICONS = {
    back: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>`,
    close: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`,
    refresh: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    check: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    bigCheck: `<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    lock: `<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
    sync: `<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>`,
    clock: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    zapLogo: `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`
  };

  // ---------------------------------------------------------------------------
  // State Store
  // ---------------------------------------------------------------------------

  const DEFAULT_QR_TTL = 30; // 30 seconds auto-refresh interval
  const DEFAULT_PAIRING_CODE_TTL = 160; // 160 seconds per WhatsApp MD spec

  const state = {
    isOpen: false,
    method: 'qr', // 'qr' | 'phone'
    uiState: 'qr', // 'qr' | 'phone_input' | 'pairing_code' | 'connecting' | 'paired' | 'syncing' | 'completed' | 'error'
    phoneNumber: '',
    countryCode: '+1',
    pairingCode: '',
    qrPayload: '',
    qrTimerRemaining: DEFAULT_QR_TTL,
    qrTimerTotal: DEFAULT_QR_TTL,
    qrTimerInterval: null,
    codeTimerRemaining: DEFAULT_PAIRING_CODE_TTL,
    codeTimerInterval: null,
    syncProgress: 0,
    syncInterval: null,
    errorMessage: '',
    deviceInfo: null
  };

  // ---------------------------------------------------------------------------
  // Native Bridge Dispatcher
  // ---------------------------------------------------------------------------

  function dispatchNativeBridge(action, payload) {
    const jsonStr = JSON.stringify(payload || {});
    try {
      if (window.ZapBridge && typeof window.ZapBridge[action] === 'function') {
        window.ZapBridge[action](jsonStr);
        return true;
      }
      if (window.Android && typeof window.Android[action] === 'function') {
        window.Android[action](jsonStr);
        return true;
      }
    } catch (err) {
      console.warn('[Bridge] Call failed:', action, err);
    }
    console.debug('[Bridge Mock Dispatch]', action, payload);
    return false;
  }

  // ---------------------------------------------------------------------------
  // DOM Elements & Lazy Initializer
  // ---------------------------------------------------------------------------

  let dom = {
    view: null,
    title: null,
    badge: null,
    backBtn: null,
    tabsContainer: null,
    tabQrBtn: null,
    tabPhoneBtn: null,
    errorBox: null,

    // Sections
    sectionQr: null,
    sectionPhoneInput: null,
    sectionPairingCode: null,
    sectionTransition: null,

    // QR section elements
    qrSvgContainer: null,
    qrExpiredOverlay: null,
    qrReloadBtn: null,
    qrTimerRingProgress: null,
    qrTimerText: null,
    qrSwitchPhoneLink: null,

    // Phone section elements
    countrySelect: null,
    phoneInput: null,
    phoneSubmitBtn: null,
    phoneSwitchQrLink: null,

    // Pairing code section elements
    codePhoneTarget: null,
    codeBoxesGroup1: null,
    codeBoxesGroup2: null,
    codeTimerText: null,
    codeCopyBtn: null,
    codeSwitchQrLink: null,

    // Transition section elements
    transitionIconSlot: null,
    transitionTitle: null,
    transitionDesc: null,
    syncProgressWrapper: null,
    syncProgressBarFill: null,
    syncProgressPercentText: null,
    syncProgressSubtext: null,
    stepDots: []
  };

  function initDOM() {
    if (dom.view) return;

    let appContainer = document.getElementById('app') || document.body;

    const view = document.createElement('div');
    view.id = 'pairing-view';
    view.className = 'pairing-view';

    view.innerHTML = `
      <header class="pairing-header">
        <div class="pairing-header-left">
          <button class="pairing-back-btn" id="pairing-back-btn" aria-label="Back">
            ${ICONS.back}
          </button>
          <h2 class="pairing-header-title" id="pairing-header-title">Tautkan Perangkat</h2>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          
          <div class="pairing-header-badge" id="pairing-header-badge">E2E ENCRYPTED</div>
        </div>
      </header>

      <div class="pairing-content">
        <!-- Error Banner -->
        <div class="pairing-error-box" id="pairing-error-box"></div>

        <!-- Mode Tabs -->
        <div class="pairing-tabs" id="pairing-tabs">
          <button class="pairing-tab-btn active" id="pairing-tab-qr" data-mode="qr">QR Code</button>
          <button class="pairing-tab-btn" id="pairing-tab-phone" data-mode="phone">Phone Number</button>
        </div>

        <!-- Section 1: QR Code -->
        <section class="pairing-section active" id="pairing-section-qr">
          <div class="qr-card-wrapper">
            <div class="qr-code-svg-container" id="qr-code-svg-container"></div>
            <div class="qr-center-logo">
              ${ICONS.zapLogo}
            </div>
            <div class="qr-expired-overlay" id="qr-expired-overlay">
              <div class="qr-expired-title">QR Code Expired</div>
              <button class="qr-reload-btn" id="qr-reload-btn">
                ${ICONS.refresh} Reload QR Code
              </button>
            </div>
          </div>

          <div class="qr-timer-bar-container">
            <svg class="qr-timer-ring" viewBox="0 0 24 24">
              <circle class="qr-timer-ring-bg" cx="12" cy="12" r="10" />
              <circle class="qr-timer-ring-progress" id="qr-timer-ring-progress" cx="12" cy="12" r="10" stroke-dasharray="62.83" stroke-dashoffset="0" />
            </svg>
            <div class="qr-timer-text" id="qr-timer-text">
              Code refreshes in <span class="qr-timer-count" id="qr-timer-count">30s</span>
            </div>
          </div>

          <div class="pairing-steps-card">
            <div class="pairing-steps-title">Langkah menautkan WhatsApp Anda:</div>
            <div class="pairing-step-item">
              <span class="pairing-step-num">1</span>
              <span class="pairing-step-text">Buka <strong>WhatsApp</strong> di ponsel utama Anda</span>
            </div>
            <div class="pairing-step-item">
              <span class="pairing-step-num">2</span>
              <span class="pairing-step-text">Ketuk <strong>Menu ⋮</strong> atau <strong>Setelan ⚙️</strong> &gt; <strong>Perangkat tertaut</strong></span>
            </div>
            <div class="pairing-step-item">
              <span class="pairing-step-num">3</span>
              <span class="pairing-step-text">Ketuk <strong>Tautkan perangkat</strong></span>
            </div>
            <div class="pairing-step-item">
              <span class="pairing-step-num">4</span>
              <span class="pairing-step-text">Arahkan kamera ke kode QR ini untuk memindai</span>
            </div>
          </div>

          <button class="pairing-switch-link" id="qr-switch-phone-link">
            Tautkan dengan nomor telepon saja &rarr;
          </button>
        </section>

        <!-- Section 2: Phone Input Form -->
        <section class="pairing-section" id="pairing-section-phone-input">
          <div class="phone-form-card">
            <label class="phone-form-label" for="phone-number-input">Enter Phone Number</label>
            <div class="phone-form-desc">
              Select your country code and enter your WhatsApp/ZapApp registered phone number to receive an 8-digit pairing code.
            </div>

            <div class="phone-input-row">
              <select class="phone-country-select" id="phone-country-select" aria-label="Country Code">
                <option value="+62" selected>Indonesia (+62)</option>
                <option value="+1">US / Canada (+1)</option>
                <option value="+44">UK (+44)</option>
                <option value="+55">BR (+55)</option>
                <option value="+91">IN (+91)</option>
                <option value="+49">DE (+49)</option>
                <option value="+33">FR (+33)</option>
                <option value="+81">JP (+81)</option>
                <option value="+61">AU (+61)</option>
              </select>
              <input type="tel" class="phone-number-input" id="phone-number-input" placeholder="(555) 019-2834" autocomplete="tel" inputmode="tel" />
            </div>

            <button class="pairing-primary-btn" id="phone-submit-btn" disabled>
              Next
            </button>
          </div>

          <button class="pairing-switch-link" id="phone-switch-qr-link">
            &larr; Link with QR code instead
          </button>
        </section>

        <!-- Section 3: 8-Digit Pairing Code Display -->
        <section class="pairing-section" id="pairing-section-pairing-code">
          <div class="code-display-card">
            <div class="code-phone-target" id="code-phone-target">
              Pairing request sent to <strong>+1 555-019-2834</strong>
            </div>
            <div class="phone-form-desc" style="text-align: center; margin-bottom: 8px;">
              Enter this 8-digit code on your phone to link this device:
            </div>

            <div class="code-boxes-container">
              <div class="code-box-group" id="code-boxes-group-1">
                <div class="code-box" id="code-char-0">-</div>
                <div class="code-box" id="code-char-1">-</div>
                <div class="code-box" id="code-char-2">-</div>
                <div class="code-box" id="code-char-3">-</div>
              </div>
              <div class="code-boxes-separator"></div>
              <div class="code-box-group" id="code-boxes-group-2">
                <div class="code-box" id="code-char-4">-</div>
                <div class="code-box" id="code-char-5">-</div>
                <div class="code-box" id="code-char-6">-</div>
                <div class="code-box" id="code-char-7">-</div>
              </div>
            </div>

            <div class="code-timer-text" id="code-timer-text">
              ${ICONS.clock} Code expires in <span id="code-timer-countdown">02:40</span>
            </div>

            <div class="code-actions-row">
              <button class="code-copy-btn" id="code-copy-btn">
                ${ICONS.copy} <span id="code-copy-btn-text">Copy Code</span>
              </button>
            </div>
          </div>

          <div class="pairing-steps-card">
            <div class="pairing-steps-title">Instructions on your phone:</div>
            <div class="pairing-step-item">
              <span class="pairing-step-num">1</span>
              <span class="pairing-step-text">Open the <strong>ZapApp notification</strong> on your phone</span>
            </div>
            <div class="pairing-step-item">
              <span class="pairing-step-num">2</span>
              <span class="pairing-step-text">Confirm <strong>Link a Device</strong> prompt</span>
            </div>
            <div class="pairing-step-item">
              <span class="pairing-step-num">3</span>
              <span class="pairing-step-text">Enter the <strong>8 characters</strong> shown above</span>
            </div>
          </div>

          <button class="pairing-switch-link" id="code-switch-qr-link">
            &larr; Switch to QR code pairing
          </button>
        </section>

        <!-- Section 4: State Transition UI (Connecting -> Paired -> Syncing chats) -->
        <section class="pairing-section" id="pairing-section-transition">
          <div class="pairing-transition-card">
            <div id="transition-icon-slot">
              <div class="transition-spinner">
                <div class="transition-spinner-circle"></div>
              </div>
            </div>

            <h3 class="transition-title" id="transition-title">Connecting to phone...</h3>
            <p class="transition-desc" id="transition-desc">
              Establishing secure Noise XX cryptographic handshake with primary device...
            </p>

            <div class="sync-progress-wrapper" id="sync-progress-wrapper" style="display: none;">
              <div class="sync-progress-bar-bg">
                <div class="sync-progress-bar-fill" id="sync-progress-bar-fill"></div>
              </div>
              <div class="sync-progress-label-row">
                <span id="sync-progress-subtext">Syncing recent messages...</span>
                <span id="sync-progress-percent">0%</span>
              </div>
            </div>

            <div class="pairing-steps-indicator">
              <span class="pairing-step-dot active" id="step-dot-1" title="Connecting"></span>
              <span class="pairing-step-dot" id="step-dot-2" title="Paired"></span>
              <span class="pairing-step-dot" id="step-dot-3" title="Syncing chats"></span>
            </div>
          </div>
        </section>
      </div>
    `;

    appContainer.appendChild(view);

    // Cache elements
    dom.view = view;
    dom.title = view.querySelector('#pairing-header-title');
    dom.badge = view.querySelector('#pairing-header-badge');
    dom.backBtn = view.querySelector('#pairing-back-btn');
    dom.tabsContainer = view.querySelector('#pairing-tabs');
    dom.tabQrBtn = view.querySelector('#pairing-tab-qr');
    dom.tabPhoneBtn = view.querySelector('#pairing-tab-phone');
    dom.errorBox = view.querySelector('#pairing-error-box');

    dom.sectionQr = view.querySelector('#pairing-section-qr');
    dom.sectionPhoneInput = view.querySelector('#pairing-section-phone-input');
    dom.sectionPairingCode = view.querySelector('#pairing-section-pairing-code');
    dom.sectionTransition = view.querySelector('#pairing-section-transition');

    dom.qrSvgContainer = view.querySelector('#qr-code-svg-container');
    dom.qrExpiredOverlay = view.querySelector('#qr-expired-overlay');
    dom.qrReloadBtn = view.querySelector('#qr-reload-btn');
    dom.qrTimerRingProgress = view.querySelector('#qr-timer-ring-progress');
    dom.qrTimerText = view.querySelector('#qr-timer-text');
    dom.qrSwitchPhoneLink = view.querySelector('#qr-switch-phone-link');

    dom.countrySelect = view.querySelector('#phone-country-select');
    dom.phoneInput = view.querySelector('#phone-number-input');
    dom.phoneSubmitBtn = view.querySelector('#phone-submit-btn');
    dom.phoneSwitchQrLink = view.querySelector('#phone-switch-qr-link');

    dom.codePhoneTarget = view.querySelector('#code-phone-target');
    dom.codeBoxesGroup1 = view.querySelector('#code-boxes-group-1');
    dom.codeBoxesGroup2 = view.querySelector('#code-boxes-group-2');
    dom.codeTimerText = view.querySelector('#code-timer-text');
    dom.codeCopyBtn = view.querySelector('#code-copy-btn');
    dom.codeSwitchQrLink = view.querySelector('#code-switch-qr-link');

    dom.transitionIconSlot = view.querySelector('#transition-icon-slot');
    dom.transitionTitle = view.querySelector('#transition-title');
    dom.transitionDesc = view.querySelector('#transition-desc');
    dom.syncProgressWrapper = view.querySelector('#sync-progress-wrapper');
    dom.syncProgressBarFill = view.querySelector('#sync-progress-bar-fill');
    dom.syncProgressPercentText = view.querySelector('#sync-progress-percent');
    dom.syncProgressSubtext = view.querySelector('#sync-progress-subtext');
    dom.stepDots = [
      view.querySelector('#step-dot-1'),
      view.querySelector('#step-dot-2'),
      view.querySelector('#step-dot-3')
    ];

    bindEvents();
  }

  function bindEvents() {
    // Skip to chat button
    const skipBtn = dom.view ? dom.view.querySelector('#pairing-skip-link') : (document.getElementById ? document.getElementById('pairing-skip-link') : null);
    if (skipBtn) {
      skipBtn.addEventListener('click', function () {
        try { localStorage.setItem('zap_is_paired', 'demo'); } catch (e) {}
        window.ZapAuth.close();
        if (window.updatePairingBanner) window.updatePairingBanner();
      });
    }

    // Back button
    if (dom.backBtn) {
      dom.backBtn.addEventListener('click', function () {
        if (state.uiState === 'phone_input' || state.uiState === 'pairing_code') {
          window.ZapAuth.switchMethod('qr');
        } else if (state.uiState === 'connecting' || state.uiState === 'error') {
          window.ZapAuth.reset();
        } else {
          window.ZapAuth.close();
        }
      });
    }

    // Tab buttons
    if (dom.tabQrBtn) {
      dom.tabQrBtn.addEventListener('click', function () {
        window.ZapAuth.switchMethod('qr');
      });
    }

    if (dom.tabPhoneBtn) {
      dom.tabPhoneBtn.addEventListener('click', function () {
        window.ZapAuth.switchMethod('phone');
      });
    }

    // QR Switch to Phone
    if (dom.qrSwitchPhoneLink) {
      dom.qrSwitchPhoneLink.addEventListener('click', function () {
        window.ZapAuth.switchMethod('phone');
      });
    }

    // QR Reload button
    if (dom.qrReloadBtn) {
      dom.qrReloadBtn.addEventListener('click', function () {
        window.ZapAuth.requestNewQr();
      });
    }

    // Phone Input events
    if (dom.phoneInput) {
      dom.phoneInput.addEventListener('input', function () {
        const val = dom.phoneInput.value.replace(/[^\d]/g, '');
        if (dom.phoneSubmitBtn) dom.phoneSubmitBtn.disabled = val.length < 7;
      });

      dom.phoneInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && dom.phoneSubmitBtn && !dom.phoneSubmitBtn.disabled) {
          handlePhoneSubmit();
        }
      });
    }

    if (dom.phoneSubmitBtn) {
      dom.phoneSubmitBtn.addEventListener('click', function () {
        handlePhoneSubmit();
      });
    }

    if (dom.phoneSwitchQrLink) {
      dom.phoneSwitchQrLink.addEventListener('click', function () {
        window.ZapAuth.switchMethod('qr');
      });
    }

    // Pairing code actions
    if (dom.codeCopyBtn) {
      dom.codeCopyBtn.addEventListener('click', function () {
        if (!state.pairingCode) return;
        const cleanCode = state.pairingCode.replace(/[^A-Za-z0-9]/g, '');
        const formatted = cleanCode.length === 8
          ? cleanCode.slice(0, 4) + '-' + cleanCode.slice(4)
          : state.pairingCode;

        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(formatted);
          }
        } catch (err) {
          console.warn('Clipboard writeText failed:', err);
        }

        dispatchNativeBridge('copyToClipboard', { text: formatted });

        const textEl = document.getElementById('code-copy-btn-text');
        if (textEl) textEl.textContent = 'Copied!';
        dom.codeCopyBtn.classList.add('copied');
        setTimeout(function () {
          if (textEl) textEl.textContent = 'Copy Code';
          dom.codeCopyBtn.classList.remove('copied');
        }, 2000);
      });
    }

    if (dom.codeSwitchQrLink) {
      dom.codeSwitchQrLink.addEventListener('click', function () {
        window.ZapAuth.switchMethod('qr');
      });
    }
  }

  function handlePhoneSubmit() {
    const rawDigits = dom.phoneInput.value.replace(/[^\d]/g, '');
    if (rawDigits.length < 7) {
      showError('Please enter a valid phone number with at least 7 digits.');
      return;
    }
    const fullPhone = dom.countrySelect.value + ' ' + rawDigits;
    window.ZapAuth.submitPhoneNumber(fullPhone);
  }

  function showError(msg) {
    state.errorMessage = msg;
    if (dom.errorBox) {
      if (msg) {
        dom.errorBox.textContent = msg;
        dom.errorBox.classList.add('active');
      } else {
        dom.errorBox.classList.remove('active');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pairing Code Generation & Display
  // ---------------------------------------------------------------------------

  const PAIRING_CHARSET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

  function generateSamplePairingCode() {
    let result = '';
    for (let i = 0; i < 8; i++) {
      const idx = Math.floor(Math.random() * PAIRING_CHARSET.length);
      result += PAIRING_CHARSET[idx];
    }
    return result;
  }

  function renderPairingCode(code) {
    const clean = (code || '--------').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const chars = clean.padEnd(8, '-').slice(0, 8);

    for (let i = 0; i < 8; i++) {
      const box = document.getElementById('code-char-' + i);
      if (box) {
        const ch = chars[i];
        box.textContent = ch;
        box.classList.toggle('filled', ch !== '-');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // QR Code Rendering & Auto-Refresh Timer
  // ---------------------------------------------------------------------------

  function renderQrCode(payload) {
    if (!dom.qrSvgContainer) return;
    const svg = generateQrSvg(payload);
    dom.qrSvgContainer.innerHTML = svg;
    if (dom.qrExpiredOverlay) dom.qrExpiredOverlay.classList.remove('active');
  }

  function startQrTimer(ttlSeconds) {
    stopQrTimer();
    state.qrTimerTotal = ttlSeconds || DEFAULT_QR_TTL;
    state.qrTimerRemaining = state.qrTimerTotal;
    updateQrTimerUI();

    state.qrTimerInterval = setInterval(function () {
      state.qrTimerRemaining--;
      updateQrTimerUI();

      if (state.qrTimerRemaining <= 0) {
        stopQrTimer();
        onQrExpired();
      }
    }, 1000);
  }

  function stopQrTimer() {
    if (state.qrTimerInterval) {
      clearInterval(state.qrTimerInterval);
      state.qrTimerInterval = null;
    }
  }

  function updateQrTimerUI() {
    const countEl = document.getElementById('qr-timer-count');
    if (countEl) countEl.textContent = state.qrTimerRemaining + 's';

    if (dom.qrTimerRingProgress) {
      const circumference = 2 * Math.PI * 10; // r=10 -> ~62.83
      const progress = Math.max(0, state.qrTimerRemaining / state.qrTimerTotal);
      const offset = circumference * (1 - progress);
      dom.qrTimerRingProgress.style.strokeDashoffset = offset.toFixed(2);
    }
  }

  function onQrExpired() {
    if (dom.qrExpiredOverlay) {
      dom.qrExpiredOverlay.classList.add('active');
    }
  }

  // ---------------------------------------------------------------------------
  // Pairing Code Countdown Timer
  // ---------------------------------------------------------------------------

  function startCodeTimer(ttlSeconds) {
    stopCodeTimer();
    state.codeTimerRemaining = ttlSeconds || DEFAULT_PAIRING_CODE_TTL;
    updateCodeTimerUI();

    state.codeTimerInterval = setInterval(function () {
      state.codeTimerRemaining--;
      updateCodeTimerUI();

      if (state.codeTimerRemaining <= 0) {
        stopCodeTimer();
        onCodeExpired();
      }
    }, 1000);
  }

  function stopCodeTimer() {
    if (state.codeTimerInterval) {
      clearInterval(state.codeTimerInterval);
      state.codeTimerInterval = null;
    }
  }

  function updateCodeTimerUI() {
    const countdownEl = document.getElementById('code-timer-countdown');
    if (!countdownEl) return;
    const mins = Math.floor(Math.max(0, state.codeTimerRemaining) / 60);
    const secs = Math.max(0, state.codeTimerRemaining) % 60;
    countdownEl.textContent = String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
  }

  function onCodeExpired() {
    showError('Pairing code expired. Please request a new code.');
    renderPairingCode('--------');
  }

  // ---------------------------------------------------------------------------
  // Sync Progress Simulation / Management
  // ---------------------------------------------------------------------------

  function stopSyncInterval() {
    if (state.syncInterval) {
      clearInterval(state.syncInterval);
      state.syncInterval = null;
    }
  }

  function updateSyncUI(progress, subtext) {
    state.syncProgress = Math.min(100, Math.max(0, progress));
    if (dom.syncProgressBarFill) {
      dom.syncProgressBarFill.style.width = state.syncProgress + '%';
    }
    if (dom.syncProgressPercentText) {
      dom.syncProgressPercentText.textContent = Math.round(state.syncProgress) + '%';
    }
    if (dom.syncProgressSubtext && subtext) {
      dom.syncProgressSubtext.textContent = subtext;
    }
  }

  // ---------------------------------------------------------------------------
  // State Machine Management
  // ---------------------------------------------------------------------------

  function updateActiveSections() {
    if (!dom.view) return;

    // Show/hide sections
    const sMap = {
      qr: dom.sectionQr,
      phone_input: dom.sectionPhoneInput,
      pairing_code: dom.sectionPairingCode,
      connecting: dom.sectionTransition,
      paired: dom.sectionTransition,
      syncing: dom.sectionTransition,
      completed: dom.sectionTransition,
      error: dom.sectionTransition
    };

    [
      dom.sectionQr,
      dom.sectionPhoneInput,
      dom.sectionPairingCode,
      dom.sectionTransition
    ].forEach(function (sec) {
      if (sec) sec.classList.remove('active');
    });

    const activeSec = sMap[state.uiState] || dom.sectionQr;
    if (activeSec) activeSec.classList.add('active');

    // Tabs visibility
    const isSetupState = (state.uiState === 'qr' || state.uiState === 'phone_input');
    if (dom.tabsContainer) {
      dom.tabsContainer.style.display = isSetupState ? 'flex' : 'none';
      dom.tabQrBtn.classList.toggle('active', state.method === 'qr');
      dom.tabPhoneBtn.classList.toggle('active', state.method === 'phone');
    }

    // Step dots
    if (state.uiState === 'connecting') {
      setStepDots(1);
    } else if (state.uiState === 'paired') {
      setStepDots(2);
    } else if (state.uiState === 'syncing' || state.uiState === 'completed') {
      setStepDots(3);
    }
  }

  function setStepDots(activeIdx) {
    dom.stepDots.forEach(function (dot, i) {
      if (!dot) return;
      dot.classList.remove('active', 'done');
      if (i + 1 < activeIdx) dot.classList.add('done');
      else if (i + 1 === activeIdx) dot.classList.add('active');
    });
  }

  // ---------------------------------------------------------------------------
  // Public Window API
  // ---------------------------------------------------------------------------

  window.ZapAuth = {
    // Initialize DOM
    init: function () {
      initDOM();
    },

    // Check if pairing overlay is currently open
    isOpen: function () {
      return state.isOpen;
    },

    // Get current state snapshot
    getState: function () {
      return Object.assign({}, state);
    },

    // Open pairing screen
    open: function (mode) {
      initDOM();
      state.isOpen = true;
      dom.view.classList.add('active');
      showError('');

      if (mode === 'phone') {
        this.switchMethod('phone');
      } else {
        this.switchMethod('qr');
      }

      dispatchNativeBridge('onPairingStateChanged', {
        fromState: 'closed',
        toState: state.uiState,
        method: state.method
      });
    },

    // Close pairing screen
    close: function () {
      stopQrTimer();
      stopCodeTimer();
      stopSyncInterval();
      state.isOpen = false;
      if (dom.view) {
        dom.view.classList.remove('active');
      }
      dispatchNativeBridge('onPairingStateChanged', {
        fromState: state.uiState,
        toState: 'closed',
        method: state.method
      });
    },

    // Switch between QR code and phone number mode
    switchMethod: function (mode) {
      initDOM();
      showError('');
      state.method = mode;

      if (mode === 'phone') {
        stopQrTimer();
        this.setState('phone_input');
        if (dom.phoneInput) {
          setTimeout(function () { dom.phoneInput.focus(); }, 150);
        }
      } else {
        stopCodeTimer();
        this.setState('qr');
        this.requestNewQr();
      }
    },

    // Set high-level state
    setState: function (newState, data) {
      initDOM();
      const prevState = state.uiState;
      state.uiState = newState;

      if (data) {
        if (data.error) showError(data.error);
        if (data.deviceInfo) state.deviceInfo = data.deviceInfo;
        if (data.phoneNumber) state.phoneNumber = data.phoneNumber;
        if (data.pairingCode) state.pairingCode = data.pairingCode;
        if (data.progress !== undefined) state.syncProgress = data.progress;
      }

      updateActiveSections();

      // UI state specific handlers
      switch (newState) {
        case 'qr':
          dom.title.textContent = 'Link a Device';
          if (!state.qrPayload) {
            this.requestNewQr();
          }
          break;

        case 'phone_input':
          dom.title.textContent = 'Enter Phone Number';
          break;

        case 'pairing_code':
          dom.title.textContent = 'Confirm on Phone';
          if (state.phoneNumber && dom.codePhoneTarget) {
            dom.codePhoneTarget.innerHTML = 'Pairing request sent to <strong>' + state.phoneNumber + '</strong>';
          }
          renderPairingCode(state.pairingCode);
          startCodeTimer(data && data.ttl ? data.ttl : DEFAULT_PAIRING_CODE_TTL);
          break;

        case 'connecting':
          dom.title.textContent = 'Connecting...';
          dom.transitionIconSlot.innerHTML = `
            <div class="transition-spinner">
              <div class="transition-spinner-circle"></div>
            </div>
          `;
          dom.transitionTitle.textContent = 'Connecting to phone...';
          dom.transitionDesc.textContent = 'Performing Noise XX handshake and verifying companion identity keys...';
          if (dom.syncProgressWrapper) dom.syncProgressWrapper.style.display = 'none';
          break;

        case 'paired':
          dom.title.textContent = 'Device Paired';
          dom.transitionIconSlot.innerHTML = `
            <div class="transition-check-icon">
              ${ICONS.bigCheck}
            </div>
          `;
          dom.transitionTitle.textContent = 'Device Paired!';
          dom.transitionDesc.textContent = state.deviceInfo && state.deviceInfo.name
            ? 'Linked to ' + state.deviceInfo.name + '. Secure session established.'
            : 'Companion device successfully registered. Preparing chat database...';
          if (dom.syncProgressWrapper) dom.syncProgressWrapper.style.display = 'none';
          break;

        case 'syncing':
          dom.title.textContent = 'Syncing Chats';
          dom.transitionIconSlot.innerHTML = `
            <div class="transition-spinner">
              <div class="transition-spinner-circle"></div>
            </div>
          `;
          dom.transitionTitle.textContent = 'Syncing chats...';
          dom.transitionDesc.textContent = 'Downloading recent messages and contact data. This may take a moment.';
          if (dom.syncProgressWrapper) dom.syncProgressWrapper.style.display = 'block';
          updateSyncUI(state.syncProgress || 0, data && data.subtext ? data.subtext : 'Syncing messages...');
          break;

        case 'completed':
          dom.title.textContent = 'All Set!';
          dom.transitionIconSlot.innerHTML = `
            <div class="transition-check-icon">
              ${ICONS.bigCheck}
            </div>
          `;
          dom.transitionTitle.textContent = 'Chats Synced!';
          dom.transitionDesc.textContent = 'Pairing complete. Welcome to ZapApp!';
          if (dom.syncProgressWrapper) dom.syncProgressWrapper.style.display = 'none';
          try { if (typeof localStorage !== 'undefined') localStorage.setItem('zap_is_paired', 'true'); } catch (e) {}
          dispatchNativeBridge('onPairingCompleted', state.deviceInfo || { deviceId: 1 });
          setTimeout(function() {
            window.ZapAuth.close(true);
            if (window.updatePairingBanner) window.updatePairingBanner();
          }, 600);
          break;

        case 'error':
          dom.title.textContent = 'Pairing Failed';
          dom.transitionIconSlot.innerHTML = `
            <div class="transition-check-icon" style="background-color: rgba(234, 67, 53, 0.15); color: var(--danger);">
              ${ICONS.close}
            </div>
          `;
          dom.transitionTitle.textContent = 'Connection Failed';
          dom.transitionDesc.textContent = state.errorMessage || 'Unable to complete pairing handshake. Please retry.';
          if (dom.syncProgressWrapper) dom.syncProgressWrapper.style.display = 'none';
          break;
      }

      dispatchNativeBridge('onPairingStateChanged', {
        fromState: prevState,
        toState: newState,
        data: data || {}
      });
    },

    // Set QR code payload directly
    setQrCode: function (payload, ttlSecs) {
      initDOM();
      state.qrPayload = payload;
      renderQrCode(payload);
      startQrTimer(ttlSecs || DEFAULT_QR_TTL);
    },

    // Request new QR code (bridge dispatch + fallback simulation)
    requestNewQr: function () {
      initDOM();
      const mockRef = 'zap_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const mockPayload = mockRef + ',NOISE_KEY_PUB_' + Date.now() + ',ID_KEY_PUB_' + Date.now();
      this.setQrCode(mockPayload, DEFAULT_QR_TTL);
      dispatchNativeBridge('onRequestQr', { ref: mockRef });
    },

    // Submit phone number to get 8-digit code
    submitPhoneNumber: function (phoneNumber) {
      initDOM();
      state.phoneNumber = phoneNumber;
      showError('');

      const generatedCode = generateSamplePairingCode();
      state.pairingCode = generatedCode;

      this.setState('pairing_code', {
        phoneNumber: phoneNumber,
        pairingCode: generatedCode,
        ttl: DEFAULT_PAIRING_CODE_TTL
      });

      dispatchNativeBridge('onRequestPairingCode', {
        phoneNumber: phoneNumber,
        code: generatedCode
      });
    },

    // Set 8-digit pairing code explicitly
    setPairingCode: function (code, ttlSecs) {
      initDOM();
      state.pairingCode = code;
      this.setState('pairing_code', {
        pairingCode: code,
        ttl: ttlSecs || DEFAULT_PAIRING_CODE_TTL
      });
    },

    // Trigger Connecting state
    startConnecting: function () {
      this.setState('connecting');
    },

    // Trigger Paired state
    setPaired: function (deviceInfo) {
      this.setState('paired', { deviceInfo: deviceInfo || { name: 'Primary Phone', id: 1 } });
    },

    // Start / update Syncing state
    startSyncing: function (durationMs, onComplete) {
      this.setState('syncing', { progress: 0 });
      const duration = durationMs || 3000;
      const startTime = Date.now();
      const self = this;

      stopSyncInterval();
      state.syncInterval = setInterval(function () {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(100, (elapsed / duration) * 100);

        let subtext = 'Downloading chat encryption keys...';
        if (progress > 30) subtext = 'Syncing conversation history...';
        if (progress > 70) subtext = 'Organizing contacts and media...';
        if (progress >= 100) subtext = 'Finalizing chat database...';

        updateSyncUI(progress, subtext);
        dispatchNativeBridge('onSyncProgress', { progress: Math.round(progress) });

        if (progress >= 100) {
          stopSyncInterval();
          self.setState('completed');
          setTimeout(function () {
            self.close();
            if (typeof onComplete === 'function') onComplete();
          }, 1200);
        }
      }, 100);
    },

    // Reset back to initial state
    reset: function () {
      stopQrTimer();
      stopCodeTimer();
      stopSyncInterval();
      showError('');
      state.pairingCode = '';
      state.phoneNumber = '';
      state.syncProgress = 0;
      this.switchMethod('qr');
    },

    // Simulate full end-to-end pairing flow (ideal for testing & demos)
    simulatePairingFlow: function (opts) {
      const self = this;
      const options = Object.assign({
        connectDelay: 1000,
        pairedDelay: 1200,
        syncDuration: 2500
      }, opts || {});

      self.startConnecting();
      setTimeout(function () {
        self.setPaired({ name: 'Pixel 8 Pro (ZapApp)', id: 1 });
        setTimeout(function () {
          self.startSyncing(options.syncDuration);
        }, options.pairedDelay);
      }, options.connectDelay);
    }
  };

  // ---------------------------------------------------------------------------
  // Android WebView / Inbound Hooks
  // ---------------------------------------------------------------------------

  window.onPairingStateUpdate = function (jsonStr) {
    try {
      const data = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
      if (data.state) {
        window.ZapAuth.setState(data.state, data);
      }
    } catch (err) {
      console.warn('[onPairingStateUpdate] Parse error:', err);
    }
  };

  window.onQrReceived = function (jsonStr) {
    try {
      const data = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
      const payload = data.qrPayload || data.payload || data;
      const ttl = data.ttl || DEFAULT_QR_TTL;
      window.ZapAuth.setQrCode(payload, ttl);
    } catch (err) {
      console.warn('[onQrReceived] Parse error:', err);
    }
  };

  window.onPairingCodeReceived = function (jsonStr) {
    try {
      const data = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
      const code = data.code || data.pairingCode || data;
      const ttl = data.ttl || DEFAULT_PAIRING_CODE_TTL;
      window.ZapAuth.setPairingCode(code, ttl);
    } catch (err) {
      console.warn('[onPairingCodeReceived] Parse error:', err);
    }
  };

  window.onSyncProgressUpdate = function (jsonStr) {
    try {
      const data = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
      const progress = typeof data.progress === 'number' ? data.progress : parseInt(data.progress, 10);
      updateSyncUI(progress, data.subtext || 'Syncing chats...');
      if (progress >= 100) {
        window.ZapAuth.setState('completed');
      }
    } catch (err) {
      console.warn('[onSyncProgressUpdate] Parse error:', err);
    }
  };

  // Auto-init on DOMContentLoaded or immediate if DOM already ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      initDOM();
    });
  } else {
    initDOM();
  }
})();
