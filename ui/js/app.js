// [xihanzu-NR]
(function () {
  'use strict';

  // State
  let activeTab = 'chats';

  // Elements
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');
  const tabIndicator = document.getElementById('tab-indicator');
  const searchInput = document.getElementById('search-input');
  const searchClear = document.getElementById('search-clear');
  const fab = document.getElementById('fab-btn');

  const fabIcons = {
    chats: `<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.2L4 17.2V4h16v12z"/><path fill="currentColor" d="M7 9h10v2H7zm0-3h10v2H7z"/></svg>`,
    status: `<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`,
    calls: `<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 0 0-1.01.24l-1.57 1.97c-2.83-1.44-5.15-3.75-6.59-6.59l1.97-1.57c.26-.26.35-.65.24-1.01A11.36 11.36 0 0 1 8.56 4c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1 0 9.39 7.61 17 17 17 .55 0 1-.45 1-1v-3.62c0-.55-.45-1-.99-1z"/></svg>`,
    settings: `<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>`
  };

  function switchTab(targetTab) {
    if (!targetTab) return;
    activeTab = targetTab;

    tabButtons.forEach(function (btn, index) {
      const isTarget = btn.getAttribute('data-tab') === targetTab;
      btn.classList.toggle('active', isTarget);
      if (isTarget && tabIndicator) {
        tabIndicator.style.transform = 'translateX(' + (index * 100) + '%)';
      }
    });

    tabPanels.forEach(function (panel) {
      panel.classList.toggle('active', panel.id === 'tab-' + targetTab);
    });

    if (fab) {
      if (targetTab === 'settings') {
        fab.style.display = 'none';
      } else {
        fab.style.display = 'flex';
        fab.innerHTML = fabIcons[targetTab] || fabIcons.chats;
      }
    }
  }

  // Event Listeners for Tabs
  tabButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      switchTab(btn.getAttribute('data-tab'));
    });
  });

  // Search filter functionality
  if (searchInput) {
    searchInput.addEventListener('input', function () {
      const query = searchInput.value.trim().toLowerCase();
      if (searchClear) {
        searchClear.classList.toggle('active', query.length > 0);
      }

      const activeList = document.querySelector('.tab-panel.active .list-group');
      if (!activeList) return;

      const items = activeList.querySelectorAll('.list-item');
      items.forEach(function (item) {
        const title = (item.querySelector('.item-title')?.textContent || '').toLowerCase();
        const snippet = (item.querySelector('.item-message')?.textContent || '').toLowerCase();
        const matches = title.includes(query) || snippet.includes(query);
        item.style.display = matches ? 'flex' : 'none';
      });
    });
  }

  if (searchClear) {
    searchClear.addEventListener('click', function () {
      if (searchInput) {
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input'));
        searchInput.focus();
      }
    });
  }

  // Open chat room when tapping any chat row
  function bindChatRowClicks() {
    document.querySelectorAll('#tab-chats .list-item').forEach(function (item) {
      item.addEventListener('click', function () {
        const title = item.querySelector('.item-title')?.textContent || 'Chat';
        const id = title.toLowerCase().replace(/\s+/g, '_');
        if (window.ZapChat && typeof window.ZapChat.openChat === 'function') {
          window.ZapChat.openChat({ id: id, name: title, status: 'online' });
        }
      });
    });
  }
  bindChatRowClicks();

  // Floating Action Button to initiate new chat or custom number
  if (fab) {
    fab.addEventListener('click', function () {
      if (activeTab === 'chats') {
        const targetNum = prompt('Masukkan nomor WhatsApp (contoh: 628123456789):');
        if (targetNum) {
          const clean = targetNum.replace(/[^0-9]/g, '');
          if (clean.length >= 7) {
            const jid = clean + '@s.whatsapp.net';
            if (window.ZapChat && typeof window.ZapChat.openChat === 'function') {
              window.ZapChat.openChat({ id: jid, name: '+' + clean, status: 'online' });
            }
          }
        }
      }
    });
  }

  // Pairing Banner Update
  function updatePairingBanner() {
    const isPaired = localStorage.getItem('zap_is_paired');
    const banner = document.getElementById('auth-prompt-banner');
    if (banner) {
      banner.style.display = isPaired === 'true' ? 'none' : 'flex';
    }
  }
  window.updatePairingBanner = updatePairingBanner;

  const authBannerBtn = document.getElementById('auth-banner-link-btn');
  if (authBannerBtn) {
    authBannerBtn.addEventListener('click', function () {
      if (window.ZapAuth && typeof window.ZapAuth.open === 'function') {
        window.ZapAuth.open('qr');
      }
    });
  }

  // Linked devices pairing trigger in settings
  const linkedDevicesBtn = document.getElementById('settings-linked-devices-btn');
  if (linkedDevicesBtn) {
    linkedDevicesBtn.addEventListener('click', function () {
      if (window.ZapAuth && typeof window.ZapAuth.open === 'function') {
        window.ZapAuth.open('qr');
      }
    });
  }

  // Zapo Buttons Composer test launcher in settings
  const testBtnsBtn = document.getElementById('settings-test-buttons-btn');
  if (testBtnsBtn) {
    testBtnsBtn.addEventListener('click', function () {
      if (window.ZapChat && typeof window.ZapChat.openChat === 'function') {
        window.ZapChat.openChat({ id: 'engineering_core', name: 'Zapo Interactive Bot', status: 'online' });
        setTimeout(function () {
          const zapoModal = document.getElementById('zapo-button-modal');
          if (zapoModal) zapoModal.classList.add('active');
        }, 300);
      }
    });
  }

  // Logout / Relink trigger
  const logoutBtn = document.getElementById('settings-logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function () {
      localStorage.removeItem('zap_is_paired');
      updatePairingBanner();
      try {
        if (window.ZapBridge && typeof window.ZapBridge.disconnect === 'function') {
          window.ZapBridge.disconnect();
        } else if (window.Android && typeof window.Android.disconnect === 'function') {
          window.Android.disconnect();
        }
      } catch (e) {}
      if (window.ZapAuth && typeof window.ZapAuth.open === 'function') {
        window.ZapAuth.open('qr');
      }
    });
  }

  // MANDATORY LOGIN CHECK:
  // If not authenticated, open Auth Screen (QR mode) automatically!
  function checkInitialAuth() {
    updatePairingBanner();
    const isPaired = localStorage.getItem('zap_is_paired');
    if (isPaired !== 'true') {
      if (window.ZapAuth && typeof window.ZapAuth.open === 'function') {
        window.ZapAuth.open('qr');
      }
    }
  }

  window.ZapAppInit = checkInitialAuth;

  // Initialize
  switchTab('chats');

  // Trigger Auth immediately on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(checkInitialAuth, 100);
    });
  } else {
    setTimeout(checkInitialAuth, 100);
  }
})();
