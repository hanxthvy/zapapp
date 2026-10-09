// [xihanzu-NR]
(function () {
  'use strict';

  // ponytail: in-memory message store and DOM-rendered bubbles; upgrade to IndexedDB and virtualized list when message volume exceeds 1,000 per thread.

  // State
  let activeChat = null;
  const messageStore = {};

  // Sample seed messages showcasing Native Flow buttons and tick statuses
  messageStore['engineering_core'] = [
    {
      id: 'msg_101',
      chatId: 'engineering_core',
      fromMe: false,
      text: 'Rust client protocol compilation verified on Android arm64 targets.',
      timestamp: Date.now() - 3600000,
      status: 'read'
    },
    {
      id: 'msg_102',
      chatId: 'engineering_core',
      fromMe: true,
      text: 'Noise XX handshake and protobuf binary frame roundtrip tests passing 100%.',
      timestamp: Date.now() - 3000000,
      status: 'read'
    },
    {
      id: 'msg_103',
      chatId: 'engineering_core',
      fromMe: false,
      text: 'Interactive Native Flow buttons activated. Select an action below:',
      timestamp: Date.now() - 1800000,
      status: 'read',
      buttons: [
        {
          type: 'quick_reply',
          display_text: 'Confirm Sync',
          id: 'qr_confirm_sync'
        },
        {
          type: 'cta_url',
          display_text: 'View Protocol Spec',
          url: 'https://github.com/zapapp/protocol'
        },
        {
          type: 'cta_copy',
          display_text: 'Copy Session Key',
          copy_code: 'ZAP-SEC-9X4F-2026'
        }
      ]
    },
    {
      id: 'msg_104',
      chatId: 'engineering_core',
      fromMe: true,
      text: 'Verified native flow button handlers and bridge message dispatch.',
      timestamp: Date.now() - 600000,
      status: 'delivered'
    }
  ];

  messageStore['devops_bot'] = [
    {
      id: 'msg_201',
      chatId: 'devops_bot',
      fromMe: false,
      text: 'Gateway container deployment healthy. All metrics nominal.',
      timestamp: Date.now() - 5400000,
      status: 'read',
      buttons: [
        {
          type: 'quick_reply',
          display_text: 'Restart Service',
          id: 'qr_restart_svc'
        },
        {
          type: 'cta_copy',
          display_text: 'Copy Deployment ID',
          copy_code: 'dep-zap-prod-8812'
        }
      ]
    }
  ];

  // SVG Icons
  const ICONS = {
    back: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>`,
    tickClock: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 3.5a.5.5 0 0 0-1 0V9a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 0 0 .496-.868L8 8.71V3.5z"/><path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm7-8A7 7 0 1 1 1 8a7 7 0 0 1 14 0z"/></svg>`,
    tickSent: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 4.5l-6.5 7L2.5 8"/></svg>`,
    tickDelivered: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 4.5l-5.5 6.5-2.5-3"/><path d="M14.5 4.5l-5.5 6.5"/></svg>`,
    tickRead: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 4.5l-5.5 6.5-2.5-3"/><path d="M14.5 4.5l-5.5 6.5"/></svg>`,
    tickFailed: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 3.5a.75.75 0 0 1 .75.75v4a.75.75 0 0 1-1.5 0v-4A.75.75 0 0 1 8 4.5zm0 8a.875.875 0 1 1 0-1.75.875.875 0 0 1 0 1.75z"/></svg>`,
    reply: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10h10a5 5 0 0 1 5 5v3M3 10l6-6M3 10l6 6"/></svg>`,
    url: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    copied: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    emoji: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>`,
    attach: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`,
    send: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`,
    mic: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
    more: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>`
  };

  const EMOJI_SET = ['👍', '❤️', '😂', '🙏', '🔥', '🎉', '🚀', '👀', '👏', '💯', '😊', '🤔', '✅', '⚡', '✨', '☕'];

  // DOM Elements
  let chatViewEl = null;
  let chatMessagesEl = null;
  let chatInputEl = null;
  let chatSendBtnEl = null;
  let emojiTrayEl = null;
  let attachTrayEl = null;

  // Bridge Outbound Dispatcher
  function dispatchNativeBridge(action, payload) {
    const jsonStr = JSON.stringify(payload);
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
    // Browser fallback
    console.debug('[Bridge Mock Dispatch]', action, payload);
    return false;
  }

  // Format timestamp (e.g., "11:42 AM")
  function formatTimestamp(ts) {
    if (!ts) return '';
    if (typeof ts === 'string' && ts.includes(':') && !ts.includes('T')) return ts;
    const date = new Date(ts);
    if (isNaN(date.getTime())) return '';
    let hours = date.getHours();
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return hours + ':' + minutes + ' ' + ampm;
  }

  // Render status tick SVG
  function renderTickIcon(status) {
    switch (status) {
      case 'read':
      case 'played':
        return `<span class="chat-tick read" title="Read">${ICONS.tickRead}</span>`;
      case 'delivered':
        return `<span class="chat-tick" title="Delivered">${ICONS.tickDelivered}</span>`;
      case 'sent':
        return `<span class="chat-tick" title="Sent">${ICONS.tickSent}</span>`;
      case 'failed':
        return `<span class="chat-tick failed" title="Failed">${ICONS.tickFailed}</span>`;
      case 'pending':
      default:
        return `<span class="chat-tick" title="Pending">${ICONS.tickClock}</span>`;
    }
  }

  // Sanitize HTML string
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Normalize Button structure (handles both high-level Button and NativeFlowButton protobuf JSON)
  function normalizeButton(rawBtn) {
    if (!rawBtn) return null;
    let bType = String(rawBtn.type || rawBtn.name || '').toLowerCase();
    let displayText = rawBtn.display_text || rawBtn.displayText || rawBtn.text || rawBtn.title || rawBtn.label || '';
    let id = rawBtn.id || rawBtn.buttonId || rawBtn.btn_id || '';
    let url = rawBtn.url || rawBtn.link || rawBtn.webUrl || '';
    let copyCode = rawBtn.copy_code || rawBtn.copyCode || rawBtn.code || rawBtn.copy || '';

    // If encoded in button_params_json string
    const paramsJson = rawBtn.button_params_json || rawBtn.buttonParamsJson;
    if (paramsJson) {
      try {
        const parsed = JSON.parse(paramsJson);
        displayText = parsed.display_text || parsed.displayText || displayText;
        id = parsed.id || parsed.buttonId || id;
        url = parsed.url || parsed.link || url;
        copyCode = parsed.copy_code || parsed.copyCode || copyCode;
      } catch (e) {
        console.warn('[Chat] Failed parsing button_params_json:', e);
      }
    }

    if (bType === 'quick_reply' || bType === 'reply' || (!bType && id)) {
      return { type: 'quick_reply', display_text: displayText || 'Reply', id: id || 'btn_1' };
    } else if (bType === 'cta_url' || bType === 'url' || (!bType && url)) {
      return { type: 'cta_url', display_text: displayText || 'Open Link', url: url || 'https://whatsapp.com' };
    } else if (bType === 'cta_copy' || bType === 'copy' || (!bType && copyCode)) {
      return { type: 'cta_copy', display_text: displayText || 'Copy Code', copy_code: copyCode };
    }
    return null;
  }

  // Render Native Flow Interactive Buttons
  function renderButtons(buttons, message) {
    if (!buttons || !buttons.length) return null;
    const container = document.createElement('div');
    container.className = 'chat-buttons-container';

    buttons.forEach(function (rawBtn) {
      const btn = normalizeButton(rawBtn);
      if (!btn) return;

      const btnEl = document.createElement('button');
      btnEl.className = 'chat-flow-btn';
      btnEl.type = 'button';

      if (btn.type === 'quick_reply') {
        btnEl.innerHTML = ICONS.reply + '<span>' + escapeHtml(btn.display_text) + '</span>';
        btnEl.addEventListener('click', function (e) {
          e.stopPropagation();
          handleQuickReply(btn.id, btn.display_text, message);
        });
      } else if (btn.type === 'cta_url') {
        btnEl.innerHTML = ICONS.url + '<span>' + escapeHtml(btn.display_text) + '</span>';
        btnEl.addEventListener('click', function (e) {
          e.stopPropagation();
          handleCtaUrl(btn.url);
        });
      } else if (btn.type === 'cta_copy') {
        btnEl.innerHTML = ICONS.copy + '<span>' + escapeHtml(btn.display_text) + '</span>';
        btnEl.addEventListener('click', function (e) {
          e.stopPropagation();
          handleCtaCopy(btn.copy_code, btnEl, btn.display_text);
        });
      }

      container.appendChild(btnEl);
    });

    return container;
  }

  // Quick Reply handler
  function handleQuickReply(id, text, origMessage) {
    if (!activeChat) return;
    dispatchNativeBridge('onQuickReplyClick', {
      chatId: activeChat.id,
      buttonId: id,
      text: text,
      originalMessageId: origMessage ? origMessage.id : null
    });
    // Send quick reply text as user message
    window.ZapChat.sendMessage(text, { quickReplyId: id });
  }

  // CTA URL Open handler
  function handleCtaUrl(url) {
    if (!url) return;
    const dispatched = dispatchNativeBridge('openUrl', { url: url });
    if (!dispatched) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  // CTA Copy button handler
  function handleCtaCopy(code, btnEl, originalText) {
    if (!code) return;
    dispatchNativeBridge('copyToClipboard', { text: code });

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).catch(function () {
        fallbackCopyText(code);
      });
    } else {
      fallbackCopyText(code);
    }

    // Feedback visual
    btnEl.classList.add('copied');
    btnEl.innerHTML = ICONS.copied + '<span>Copied!</span>';
    setTimeout(function () {
      btnEl.classList.remove('copied');
      btnEl.innerHTML = ICONS.copy + '<span>' + escapeHtml(originalText) + '</span>';
    }, 2000);
  }

  function fallbackCopyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
    } catch (e) {
      console.warn('Copy fallback failed:', e);
    }
    document.body.removeChild(ta);
  }

  // Render single message row
  function createMessageElement(msg) {
    const row = document.createElement('div');
    row.className = 'chat-row ' + (msg.fromMe ? 'outgoing' : 'incoming');
    row.setAttribute('data-msg-id', msg.id);

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';

    // Content text
    const textEl = document.createElement('span');
    textEl.className = 'chat-bubble-text';
    textEl.innerHTML = escapeHtml(msg.text).replace(/\n/g, '<br>');
    bubble.appendChild(textEl);

    // Metadata (timestamp & status ticks)
    const metaEl = document.createElement('span');
    metaEl.className = 'chat-bubble-meta';
    let metaContent = escapeHtml(formatTimestamp(msg.timestamp));
    if (msg.fromMe) {
      metaContent += ' ' + renderTickIcon(msg.status || 'pending');
    }
    metaEl.innerHTML = metaContent;
    bubble.appendChild(metaEl);

    // Interactive buttons if present
    if (msg.buttons && msg.buttons.length) {
      if (msg.viewOnce) {
        const voBadge = document.createElement('div');
        voBadge.className = 'chat-viewonce-badge';
        voBadge.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg><span>viewOnce</span>`;
        bubble.appendChild(voBadge);
      }
      const btnsEl = renderButtons(msg.buttons, msg);
      if (btnsEl) bubble.appendChild(btnsEl);
    }

    row.appendChild(bubble);
    return row;
  }

  // Scroll message container to bottom
  function scrollToBottom(smooth) {
    if (!chatMessagesEl) return;
    requestAnimationFrame(function () {
      chatMessagesEl.scrollTo({
        top: chatMessagesEl.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto'
      });
    });
  }

  // Zapo Button Composer Modal logic
  function handleComposerSubmit() {
    const zapoModal = document.getElementById('zapo-button-modal');
    if (!zapoModal) return;

    const getEl = (id) => (zapoModal ? zapoModal.querySelector('#' + id) : null) || document.getElementById(id);

    const captionInput = getEl('zapo-modal-caption');
    const btn1Enable = getEl('zapo-modal-btn1-enable');
    const btn1TextInput = getEl('zapo-modal-btn1-text');
    const btn1IdInput = getEl('zapo-modal-btn1-id');

    const btn2Enable = getEl('zapo-modal-btn2-enable');
    const btn2TextInput = getEl('zapo-modal-btn2-text');
    const btn2UrlInput = getEl('zapo-modal-btn2-url');

    const btn3Enable = getEl('zapo-modal-btn3-enable');
    const btn3TextInput = getEl('zapo-modal-btn3-text');
    const btn3CodeInput = getEl('zapo-modal-btn3-code');

    const viewOnceInput = getEl('zapo-modal-viewonce');

    const caption = (captionInput && captionInput.value && captionInput.value.trim())
      ? captionInput.value.trim()
      : 'Silakan pilih salah satu opsi di bawah:';

    const buttons = [];

    // 1. Quick Reply
    const isBtn1Active = !btn1Enable || btn1Enable.checked;
    const btn1Text = btn1TextInput && btn1TextInput.value ? btn1TextInput.value.trim() : '';
    const btn1Id = btn1IdInput && btn1IdInput.value ? btn1IdInput.value.trim() : 'btn_opt_1';
    if (isBtn1Active && btn1Text) {
      buttons.push({
        type: 'quick_reply',
        display_text: btn1Text,
        id: btn1Id
      });
    }

    // 2. CTA URL
    const isBtn2Active = !btn2Enable || btn2Enable.checked;
    const btn2Text = btn2TextInput && btn2TextInput.value ? btn2TextInput.value.trim() : '';
    const btn2Url = btn2UrlInput && btn2UrlInput.value ? btn2UrlInput.value.trim() : 'https://whatsapp.com';
    if (isBtn2Active && btn2Text) {
      buttons.push({
        type: 'cta_url',
        display_text: btn2Text,
        url: btn2Url
      });
    }

    // 3. CTA Copy
    const isBtn3Active = !btn3Enable || btn3Enable.checked;
    const btn3Text = btn3TextInput && btn3TextInput.value ? btn3TextInput.value.trim() : '';
    const btn3Code = btn3CodeInput && btn3CodeInput.value ? btn3CodeInput.value.trim() : 'ZAPO-DISCOUNT-50';
    if (isBtn3Active && btn3Text) {
      buttons.push({
        type: 'cta_copy',
        display_text: btn3Text,
        copy_code: btn3Code
      });
    }

    // Fallback if no buttons active
    if (buttons.length === 0) {
      buttons.push({
        type: 'quick_reply',
        display_text: 'Konfirmasi',
        id: 'btn_opt_1'
      });
    }

    const isViewOnce = viewOnceInput ? Boolean(viewOnceInput.checked) : true;

    if (window.ZapChat && typeof window.ZapChat.sendButtonMessage === 'function') {
      window.ZapChat.sendButtonMessage(caption, buttons, { viewOnce: isViewOnce });
    }

    zapoModal.classList.remove('active');
  }

  function initButtonComposer() {
    let zapoModal = document.getElementById('zapo-button-modal');
    if (!zapoModal) {
      // Dynamic fallback for standalone or test environments
      const modalWrapper = document.createElement('div');
      modalWrapper.innerHTML = `
        <div class="zapo-modal-overlay" id="zapo-button-modal" role="dialog" aria-modal="true" aria-labelledby="zapo-modal-title">
          <div class="zapo-modal-sheet">
            <div class="zapo-modal-header">
              <div class="zapo-modal-title" id="zapo-modal-title">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                <span>Kirim Pesan Tombol (Zapo ViewOnce)</span>
              </div>
              <button type="button" class="zapo-modal-close" id="zapo-modal-close-btn" aria-label="Tutup">&times;</button>
            </div>
            <div class="zapo-form-group">
              <label class="zapo-form-label" for="zapo-modal-caption">Teks Pesan / Keterangan</label>
              <input type="text" class="zapo-input" id="zapo-modal-caption" placeholder="Teks pesan..." value="Silakan pilih salah satu opsi di bawah:" />
            </div>
            <div class="zapo-form-group">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <label class="zapo-form-label" for="zapo-modal-btn1-text" style="margin-bottom:0;">Tombol 1: Quick Reply (Balas Cepat)</label>
                <label style="font-size:0.75rem;color:#8696a0;display:flex;align-items:center;gap:4px;cursor:pointer;">
                  <input type="checkbox" id="zapo-modal-btn1-enable" checked /> Aktif
                </label>
              </div>
              <input type="text" class="zapo-input" id="zapo-modal-btn1-text" placeholder="Teks tombol (mis: Konfirmasi)" value="Konfirmasi Pesanan" />
              <input type="text" class="zapo-input" id="zapo-modal-btn1-id" placeholder="ID tombol (mis: qr_confirm_1)" value="btn_opt_1" style="margin-top:4px;font-size:0.8rem;opacity:0.9;" />
            </div>
            <div class="zapo-form-group">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <label class="zapo-form-label" for="zapo-modal-btn2-text" style="margin-bottom:0;">Tombol 2: Buka Tautan URL (CTA URL)</label>
                <label style="font-size:0.75rem;color:#8696a0;display:flex;align-items:center;gap:4px;cursor:pointer;">
                  <input type="checkbox" id="zapo-modal-btn2-enable" checked /> Aktif
                </label>
              </div>
              <input type="text" class="zapo-input" id="zapo-modal-btn2-text" placeholder="Teks tombol (mis: Buka Website)" value="Buka Website" />
              <input type="text" class="zapo-input" id="zapo-modal-btn2-url" placeholder="URL tujuan (mis: https://whatsapp.com)" value="https://whatsapp.com" style="margin-top:4px;" />
            </div>
            <div class="zapo-form-group">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <label class="zapo-form-label" for="zapo-modal-btn3-text" style="margin-bottom:0;">Tombol 3: Salin Kode / Voucher (Copy)</label>
                <label style="font-size:0.75rem;color:#8696a0;display:flex;align-items:center;gap:4px;cursor:pointer;">
                  <input type="checkbox" id="zapo-modal-btn3-enable" checked /> Aktif
                </label>
              </div>
              <input type="text" class="zapo-input" id="zapo-modal-btn3-text" placeholder="Teks tombol (mis: Salin Kode Promo)" value="Salin Kode Promo" />
              <input type="text" class="zapo-input" id="zapo-modal-btn3-code" placeholder="Kode yang disalin (mis: ZAPO-DISCOUNT-50)" value="ZAPO-DISCOUNT-50" style="margin-top:4px;" />
            </div>
            <label class="zapo-checkbox-label">
              <input type="checkbox" id="zapo-modal-viewonce" checked />
              <span>Bungkus dengan <strong>viewOnce</strong> (Bypass batasan Meta)</span>
            </label>
            <button type="button" class="zapo-btn-send" id="zapo-modal-submit-btn">Kirim Tombol Sekarang</button>
          </div>
        </div>
      `;
      const container = document.getElementById('app') || document.body;
      const child = modalWrapper.firstElementChild || (modalWrapper.children && modalWrapper.children[0]);
      if (container && child) {
        if (modalWrapper.children && modalWrapper.children.length > 1 && child.children && child.children.length === 0) {
          child.children = modalWrapper.children.slice(1);
        }
        container.appendChild(child);
      }
      zapoModal = document.getElementById('zapo-button-modal');
    }

    if (!zapoModal || zapoModal._composerBound) return;
    zapoModal._composerBound = true;

    const closeBtn = (zapoModal ? zapoModal.querySelector('#zapo-modal-close-btn') : null) || document.getElementById('zapo-modal-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        zapoModal.classList.remove('active');
      });
    }

    // Dismiss on overlay backdrop click
    zapoModal.addEventListener('click', function (e) {
      if (e.target === zapoModal) {
        zapoModal.classList.remove('active');
      }
    });

    const submitBtn = (zapoModal ? zapoModal.querySelector('#zapo-modal-submit-btn') : null) || document.getElementById('zapo-modal-submit-btn');
    if (submitBtn) {
      submitBtn.addEventListener('click', handleComposerSubmit);
    }
  }

  // Dismiss on Escape key
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        const zapoModal = document.getElementById('zapo-button-modal');
        if (zapoModal && zapoModal.classList.contains('active')) {
          zapoModal.classList.remove('active');
        }
      }
    });
  }

  // Mount Chat View into DOM
  function initChatViewDOM() {
    if (chatViewEl) return;

    chatViewEl = document.createElement('div');
    chatViewEl.className = 'chat-view';
    chatViewEl.id = 'chat-view';

    chatViewEl.innerHTML = `
      <header class="chat-header">
        <button class="chat-back-btn" id="chat-back-btn" aria-label="Back">
          ${ICONS.back}
        </button>
        <div class="chat-header-profile" id="chat-header-profile">
          <div class="chat-header-avatar" id="chat-header-avatar">?</div>
          <div class="chat-header-info">
            <div class="chat-header-name" id="chat-header-name">Chat</div>
            <div class="chat-header-status" id="chat-header-status">online</div>
          </div>
        </div>
        <div class="chat-header-actions">
          <button class="icon-btn" aria-label="More options">
            ${ICONS.more}
          </button>
        </div>
      </header>

      <div class="chat-messages" id="chat-messages"></div>

      <!-- Emoji Tray -->
      <div class="chat-tray emoji-tray" id="emoji-tray">
        <div class="emoji-grid" id="emoji-grid"></div>
      </div>

      <!-- Attachment Tray -->
      <div class="chat-tray attachment-tray" id="attachment-tray">
        <div class="attachment-grid">
          <div class="attach-item" data-type="document">
            <div class="attach-circle document">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
            </div>
            <span class="attach-label">Document</span>
          </div>
          <div class="attach-item" data-type="camera">
            <div class="attach-circle camera">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
            </div>
            <span class="attach-label">Camera</span>
          </div>
          <div class="attach-item" data-type="gallery">
            <div class="attach-circle gallery">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>
            </div>
            <span class="attach-label">Gallery</span>
          </div>
          <div class="attach-item" data-type="zapo_buttons" id="attach-zapo-buttons">
            <div class="attach-circle" style="background-color: #00a884; color: #111b21;">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            </div>
            <span class="attach-label" style="color: #00a884; font-weight: 600;">Zapo Buttons</span>
          </div>
          <div class="attach-item" data-type="contact">
            <div class="attach-circle contact">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>
            </div>
            <span class="attach-label">Contact</span>
          </div>
        </div>
      </div>

      <!-- Input Bar -->
      <footer class="chat-input-bar">
        <div class="chat-input-wrapper">
          <button class="chat-action-btn" id="chat-emoji-btn" aria-label="Emoji">
            ${ICONS.emoji}
          </button>
          <textarea class="chat-input" id="chat-input" rows="1" placeholder="Message"></textarea>
          <button class="chat-action-btn" id="chat-attach-btn" aria-label="Attach">
            ${ICONS.attach}
          </button>
        </div>
        <button class="chat-send-btn" id="chat-send-btn" aria-label="Send message">
          ${ICONS.mic}
        </button>
      </footer>
    `;

    const appContainer = document.getElementById('app') || document.body;
    appContainer.appendChild(chatViewEl);

    // Cache elements
    chatMessagesEl = document.getElementById('chat-messages');
    chatInputEl = document.getElementById('chat-input');
    chatSendBtnEl = document.getElementById('chat-send-btn');
    emojiTrayEl = document.getElementById('emoji-tray');
    attachTrayEl = document.getElementById('attachment-tray');

    // Populate emoji tray
    const emojiGrid = document.getElementById('emoji-grid');
    EMOJI_SET.forEach(function (emoji) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'emoji-btn';
      btn.textContent = emoji;
      btn.addEventListener('click', function () {
        chatInputEl.value += emoji;
        updateSendButtonState();
        chatInputEl.focus();
      });
      emojiGrid.appendChild(btn);
    });

    // Wire listeners
    document.getElementById('chat-back-btn').addEventListener('click', function () {
      window.ZapChat.closeChat();
    });

    document.getElementById('chat-emoji-btn').addEventListener('click', function () {
      attachTrayEl.classList.remove('active');
      emojiTrayEl.classList.toggle('active');
      scrollToBottom(false);
    });

    document.getElementById('chat-attach-btn').addEventListener('click', function () {
      emojiTrayEl.classList.remove('active');
      attachTrayEl.classList.toggle('active');
      scrollToBottom(false);
    });

    // Initialize composer modal bindings
    initButtonComposer();

    chatViewEl.querySelectorAll('.attach-item').forEach(function (item) {
      item.addEventListener('click', function () {
        const attachType = item.getAttribute('data-type');
        attachTrayEl.classList.remove('active');
        if (attachType === 'zapo_buttons') {
          window.ZapChat.openButtonComposer();
        } else {
          dispatchNativeBridge('pickAttachment', { type: attachType });
        }
      });
    });

    chatInputEl.addEventListener('input', function () {
      updateSendButtonState();
      // Auto-grow textarea height
      chatInputEl.style.height = 'auto';
      chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, 100) + 'px';
    });

    chatInputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitCurrentInput();
      }
    });

    chatInputEl.addEventListener('focus', function () {
      emojiTrayEl.classList.remove('active');
      attachTrayEl.classList.remove('active');
      setTimeout(function () { scrollToBottom(true); }, 150);
    });

    chatSendBtnEl.addEventListener('click', function () {
      submitCurrentInput();
    });
  }

  function updateSendButtonState() {
    if (!chatInputEl || !chatSendBtnEl) return;
    const hasText = chatInputEl.value.trim().length > 0;
    chatSendBtnEl.innerHTML = hasText ? ICONS.send : ICONS.mic;
    chatSendBtnEl.setAttribute('aria-label', hasText ? 'Send message' : 'Voice note');
  }

  function submitCurrentInput() {
    if (!chatInputEl) return;
    const text = chatInputEl.value.trim();
    if (!text) {
      // Voice message trigger
      dispatchNativeBridge('onVoiceNoteRecord', { chatId: activeChat ? activeChat.id : null });
      return;
    }
    window.ZapChat.sendMessage(text);
    chatInputEl.value = '';
    chatInputEl.style.height = 'auto';
    updateSendButtonState();
    if (emojiTrayEl) emojiTrayEl.classList.remove('active');
    if (attachTrayEl) attachTrayEl.classList.remove('active');
  }

  // Public API exposed on window
  window.ZapChat = {
    // Open a chat conversation
    openChat: function (chat) {
      if (!chat) return;
      initChatViewDOM();
      activeChat = chat;

      const nameEl = document.getElementById('chat-header-name');
      const avatarEl = document.getElementById('chat-header-avatar');
      const statusEl = document.getElementById('chat-header-status');

      if (nameEl) nameEl.textContent = chat.name || 'Chat';
      if (avatarEl) avatarEl.textContent = (chat.name || 'Z').charAt(0).toUpperCase();
      if (statusEl) statusEl.textContent = chat.status || 'online';

      chatMessagesEl.innerHTML = '';

      // Date separator
      const dateSep = document.createElement('div');
      dateSep.className = 'chat-date-separator';
      dateSep.textContent = 'Today';
      chatMessagesEl.appendChild(dateSep);

      // Render conversation messages
      const msgs = messageStore[chat.id] || [];
      msgs.forEach(function (msg) {
        chatMessagesEl.appendChild(createMessageElement(msg));
      });

      chatViewEl.classList.add('active');
      scrollToBottom(false);

      dispatchNativeBridge('onChatOpened', { chatId: chat.id });
    },

    // Close active chat
    closeChat: function () {
      if (chatViewEl) {
        chatViewEl.classList.remove('active');
        if (emojiTrayEl) emojiTrayEl.classList.remove('active');
        if (attachTrayEl) attachTrayEl.classList.remove('active');
      }
      if (activeChat) {
        dispatchNativeBridge('onChatClosed', { chatId: activeChat.id });
      }
      activeChat = null;
    },

    // Open Zapo Button Composer Modal
    openButtonComposer: function (chatId) {
      if (chatId) {
        window.ZapChat.openChat({ id: chatId, name: 'Zapo Interactive Bot', status: 'online' });
      } else if (!activeChat) {
        window.ZapChat.openChat({ id: 'engineering_core', name: 'Zapo Interactive Bot', status: 'online' });
      }
      initButtonComposer();
      const zapoModal = document.getElementById('zapo-button-modal');
      if (zapoModal) {
        zapoModal.classList.add('active');
      }
    },

    // Close Zapo Button Composer Modal
    closeButtonComposer: function () {
      const zapoModal = document.getElementById('zapo-button-modal');
      if (zapoModal) {
        zapoModal.classList.remove('active');
      }
    },

    // Send interactive button message (Zapo native flow wrapped in viewOnce)
    sendButtonMessage: function (text, buttons, extra) {
      if (!activeChat) {
        window.ZapChat.openChat({ id: 'engineering_core', name: 'Zapo Interactive Bot', status: 'online' });
      }
      const msgId = 'msg_btn_' + Date.now();
      const isViewOnce = extra && extra.viewOnce !== undefined ? !!extra.viewOnce : true;
      const newMsg = Object.assign({
        id: msgId,
        chatId: activeChat.id,
        fromMe: true,
        text: text,
        timestamp: Date.now(),
        status: 'sent',
        buttons: buttons || [],
        viewOnce: isViewOnce
      }, extra || {});

      if (!messageStore[activeChat.id]) {
        messageStore[activeChat.id] = [];
      }
      messageStore[activeChat.id].push(newMsg);

      if (chatMessagesEl) {
        const row = createMessageElement(newMsg);
        chatMessagesEl.appendChild(row);
        scrollToBottom(true);
      }

      // Format buttons for Native Flow protobuf schema
      const normButtons = (buttons || []).map(function (b, idx) {
        const norm = normalizeButton(b);
        if (!norm) return null;
        if (norm.type === 'quick_reply') {
          return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: norm.display_text, id: norm.id }) };
        } else if (norm.type === 'cta_url') {
          return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: norm.display_text, url: norm.url }) };
        } else if (norm.type === 'cta_copy') {
          return { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: norm.display_text, copy_code: norm.copy_code }) };
        }
        return null;
      }).filter(Boolean);

      const buttonsJson = JSON.stringify(buttons || []);
      const payload = {
        id: msgId,
        to: activeChat.id,
        chatId: activeChat.id,
        text: text,
        buttons: buttons || [],
        buttonsJson: buttonsJson,
        viewOnce: isViewOnce
      };

      if (isViewOnce) {
        payload.viewOnceMessage = {
          message: {
            interactiveMessage: {
              body: { text: text },
              nativeFlowMessage: {
                buttons: normButtons
              }
            }
          }
        };
      }

      // Dispatch to Android Native Bridge
      try {
        let dispatched = false;
        const bridgeObj = window.ZapBridge || window.Android;
        if (bridgeObj && typeof bridgeObj.sendButtonMessage === 'function') {
          if (bridgeObj.sendButtonMessage.length === 1) {
            bridgeObj.sendButtonMessage(JSON.stringify(payload));
            dispatched = true;
          } else {
            try {
              bridgeObj.sendButtonMessage(activeChat.id, text, buttonsJson);
              dispatched = true;
            } catch (_) {
              bridgeObj.sendButtonMessage(JSON.stringify(payload));
              dispatched = true;
            }
          }
        }
        if (!dispatched) {
          dispatchNativeBridge('sendButtonMessage', payload);
        }
      } catch (e) {
        console.warn('[Chat] Native sendButtonMessage failed:', e);
      }

      // Simulated local tick progression for offline/standalone test
      setTimeout(function () {
        window.ZapChat.updateMessageStatus(msgId, 'sent');
      }, 400);
      setTimeout(function () {
        window.ZapChat.updateMessageStatus(msgId, 'delivered');
      }, 1000);

      return msgId;
    },

    // Send a message
    sendMessage: function (text, extra) {
      if (!activeChat || !text) return;
      const msgId = 'msg_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
      const newMsg = Object.assign({
        id: msgId,
        chatId: activeChat.id,
        fromMe: true,
        text: text,
        timestamp: Date.now(),
        status: 'pending'
      }, extra || {});

      if (!messageStore[activeChat.id]) {
        messageStore[activeChat.id] = [];
      }
      messageStore[activeChat.id].push(newMsg);

      if (chatMessagesEl) {
        const row = createMessageElement(newMsg);
        chatMessagesEl.appendChild(row);
        scrollToBottom(true);
      }

      // Dispatch to Android Native Bridge
      dispatchNativeBridge('sendMessage', {
        id: msgId,
        chatId: activeChat.id,
        text: text,
        extra: extra || null
      });

      // Simulated local tick progression for offline/standalone test
      setTimeout(function () {
        window.ZapChat.updateMessageStatus(msgId, 'sent');
      }, 400);
      setTimeout(function () {
        window.ZapChat.updateMessageStatus(msgId, 'delivered');
      }, 1000);
    },

    // Inbound listener from Android Native
    receiveMessage: function (data) {
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch (e) {
          console.error('[Chat] Failed parsing receiveMessage payload:', e);
          return;
        }
      }
      if (!data || !data.chatId) return;

      const msg = {
        id: data.id || ('msg_' + Date.now()),
        chatId: data.chatId,
        fromMe: Boolean(data.fromMe),
        text: data.text || '',
        timestamp: data.timestamp || Date.now(),
        status: data.status || 'read',
        buttons: data.buttons || []
      };

      if (!messageStore[msg.chatId]) {
        messageStore[msg.chatId] = [];
      }
      messageStore[msg.chatId].push(msg);

      // If viewing this chat right now, render immediately
      if (activeChat && activeChat.id === msg.chatId && chatMessagesEl) {
        chatMessagesEl.appendChild(createMessageElement(msg));
        scrollToBottom(true);
      }
    },

    // Inbound status update listener (ticks: pending -> sent -> delivered -> read)
    updateMessageStatus: function (msgId, status) {
      if (!msgId || !status) return;

      // Update in store
      Object.keys(messageStore).forEach(function (cid) {
        const list = messageStore[cid];
        for (let i = 0; i < list.length; i++) {
          if (list[i].id === msgId) {
            list[i].status = status;
            break;
          }
        }
      });

      // Update in DOM if visible
      if (chatMessagesEl) {
        const row = chatMessagesEl.querySelector(`[data-msg-id="${msgId}"]`);
        if (row) {
          const metaEl = row.querySelector('.chat-bubble-meta');
          const tickEl = row.querySelector('.chat-tick');
          if (tickEl) {
            tickEl.outerHTML = renderTickIcon(status);
          } else if (metaEl) {
            metaEl.insertAdjacentHTML('beforeend', ' ' + renderTickIcon(status));
          }
        }
      }
    },

    // Get current message store
    getMessages: function (chatId) {
      return messageStore[chatId] || [];
    },

    // Get active chat
    getActiveChat: function () {
      return activeChat;
    }
  };

  // Global Bridge Callbacks for Android WebView evaluateJavascript
  window.onReceiveMessage = function (payload) {
    window.ZapChat.receiveMessage(payload);
  };

  window.onMessageStatusUpdate = function (msgId, status) {
    window.ZapChat.updateMessageStatus(msgId, status);
  };

  window.onMessageStatus = function (msgId, status) {
    window.ZapChat.updateMessageStatus(msgId, status);
  };

  // Custom DOM Event Listeners for native wrappers
  window.addEventListener('zap:message', function (e) {
    window.ZapChat.receiveMessage(e.detail);
  });

  window.addEventListener('zap:status', function (e) {
    if (e.detail && e.detail.id && e.detail.status) {
      window.ZapChat.updateMessageStatus(e.detail.id, e.detail.status);
    }
  });

  // Wire list item clicks in Chat tab to open chat view
  function wireChatListItems() {
    const chatItems = document.querySelectorAll('#tab-chats .list-item');
    const defaultIds = ['engineering_core', 'devops_bot', 'support_team', 'platform_arch'];

    chatItems.forEach(function (item, idx) {
      const title = item.querySelector('.item-title')?.textContent || 'Contact';
      const id = defaultIds[idx] || ('chat_' + idx);
      item.setAttribute('data-chat-id', id);

      item.addEventListener('click', function () {
        window.ZapChat.openChat({
          id: id,
          name: title,
          status: id === 'engineering_core' ? 'online' : (id === 'devops_bot' ? 'automated bot' : 'last seen recently')
        });
      });
    });
  }

  // Auto-initialize when DOM is ready
  function initAll() {
    wireChatListItems();
    initButtonComposer();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
})();
