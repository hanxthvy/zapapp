// [xihanzu-NR]
'use strict';

/**
 * Interactive Native Flow Buttons Serializer & ViewOnce Wrapper for ZapApp.
 * Constructs Proto.IMessage containing interactiveMessage with nativeFlowMessage:
 * - buttons: quick_reply, cta_url, cta_copy
 * - wraps interactiveMessage inside viewOnceMessage to bypass Meta personal account button blocking
 * - sends via client.message.send(to, payload)
 */

// ponytail: in-memory button schema parser; upgrade to external protobuf schema compiler if custom bloks widgets required.

// -----------------------------------------------------------------------------
// 1. Runtime Proto Loader
// -----------------------------------------------------------------------------

function resolveProto() {
  const loaders = [
    () => require('./zapo-bundle').proto,
    () => require('/tmp/zapo').proto,
    () => require('zapo-js').proto
  ];
  for (const load of loaders) {
    try {
      const p = load();
      if (p && p.Message) return p;
    } catch (_) {}
  }
  return null;
}

// -----------------------------------------------------------------------------
// 2. Native Flow Button Serializers
// -----------------------------------------------------------------------------

const BUTTON_TYPES = {
  QUICK_REPLY: 'quick_reply',
  CTA_URL: 'cta_url',
  CTA_COPY: 'cta_copy'
};

function serializeQuickReply(btn, idx) {
  const displayText = btn.display_text || btn.displayText || btn.text || btn.title || btn.label || `Action ${idx + 1}`;
  const id = btn.id || btn.buttonId || btn.btn_id || `btn_${idx + 1}`;
  return {
    name: BUTTON_TYPES.QUICK_REPLY,
    buttonParamsJson: JSON.stringify({
      display_text: String(displayText),
      id: String(id)
    })
  };
}

function serializeCtaUrl(btn, idx) {
  const displayText = btn.display_text || btn.displayText || btn.text || btn.title || btn.label || 'Open Link';
  const url = btn.url || btn.link || btn.webUrl || 'https://whatsapp.com';
  const params = {
    display_text: String(displayText),
    url: String(url)
  };
  if (btn.merchant_url || btn.merchantUrl) {
    params.merchant_url = String(btn.merchant_url || btn.merchantUrl);
  }
  return {
    name: BUTTON_TYPES.CTA_URL,
    buttonParamsJson: JSON.stringify(params)
  };
}

function serializeCtaCopy(btn, idx) {
  const displayText = btn.display_text || btn.displayText || btn.text || btn.title || btn.label || 'Copy Code';
  const copyCode = btn.copy_code || btn.copyCode || btn.code || btn.copy || 'CODE';
  return {
    name: BUTTON_TYPES.CTA_COPY,
    buttonParamsJson: JSON.stringify({
      display_text: String(displayText),
      copy_code: String(copyCode)
    })
  };
}

function serializeNativeFlowButton(btn, idx = 0) {
  if (!btn) {
    return serializeQuickReply({}, idx);
  }

  // If already string (plain label)
  if (typeof btn === 'string') {
    return serializeQuickReply({ display_text: btn, id: `btn_${idx + 1}` }, idx);
  }

  // If already compiled nativeFlowButton with name and buttonParamsJson
  if (btn.name && typeof btn.buttonParamsJson === 'string') {
    return {
      name: btn.name,
      buttonParamsJson: btn.buttonParamsJson
    };
  }

  const type = String(btn.type || btn.name || '').toLowerCase();

  if (type === 'cta_url' || type === 'url' || btn.url || btn.link) {
    return serializeCtaUrl(btn, idx);
  }
  if (type === 'cta_copy' || type === 'copy' || btn.copy_code || btn.copyCode || btn.code) {
    return serializeCtaCopy(btn, idx);
  }
  return serializeQuickReply(btn, idx);
}

function parseButtons(rawButtons) {
  if (!rawButtons) return [];
  let buttons = rawButtons;
  if (typeof buttons === 'string') {
    try {
      buttons = JSON.parse(buttons);
    } catch (_) {
      buttons = [{ type: 'quick_reply', display_text: buttons, id: 'btn_1' }];
    }
  }
  if (!Array.isArray(buttons)) {
    buttons = [buttons];
  }
  return buttons.map((b, idx) => serializeNativeFlowButton(b, idx));
}

// -----------------------------------------------------------------------------
// 3. Interactive Message & ViewOnce Builders
// -----------------------------------------------------------------------------

function buildInteractiveMessage(options = {}) {
  const text = options.text || options.body || options.content || '';
  const buttons = parseButtons(options.buttons || options.buttonsJson || []);

  const nativeFlowMessage = {
    buttons: buttons,
    messageParamsJson: options.messageParamsJson || '',
    messageVersion: typeof options.messageVersion === 'number' ? options.messageVersion : 3
  };

  const interactiveMessage = {
    body: { text: String(text) },
    nativeFlowMessage: nativeFlowMessage
  };

  if (options.header || options.title) {
    const hdr = options.header || options.title;
    interactiveMessage.header = typeof hdr === 'string'
      ? { title: hdr, hasMediaAttachment: false }
      : hdr;
  }

  if (options.footer) {
    interactiveMessage.footer = typeof options.footer === 'string'
      ? { text: options.footer }
      : options.footer;
  }

  if (options.contextInfo) {
    interactiveMessage.contextInfo = options.contextInfo;
  }

  return interactiveMessage;
}

function wrapInViewOnce(interactiveMessage, proto) {
  const payload = {
    viewOnceMessage: {
      message: {
        interactiveMessage: interactiveMessage
      }
    }
  };

  const p = proto || resolveProto();
  if (p && typeof p.Message === 'function') {
    try {
      return new p.Message(payload);
    } catch (_) {}
  }
  return payload;
}

function constructProtoMessage(options = {}, proto) {
  const interactiveMessage = buildInteractiveMessage(options);
  return wrapInViewOnce(interactiveMessage, proto);
}

// -----------------------------------------------------------------------------
// 4. Message Sender & Command Handler
// -----------------------------------------------------------------------------

async function sendButtonMessage(client, to, options = {}) {
  if (!client) throw new Error('WhatsApp client instance is required');
  const recipient = to || options.to || options.chatId || options.recipient || options.jid;
  if (!recipient) throw new Error('Missing recipient JID');

  const payload = constructProtoMessage(options);
  const sendOpts = Object.assign({}, options.sendOptions || options.options || {});

  const quoteId = options.replyToId || options.quotedId || options.quoteId;
  if (quoteId) {
    sendOpts.quote = {
      key: {
        remoteJid: recipient,
        id: quoteId,
        fromMe: false
      }
    };
  }

  const result = await client.message.send(recipient, payload, sendOpts);
  const msgId = result?.id || options.id || `msg_${Date.now()}`;

  return {
    status: 'ok',
    id: msgId,
    to: recipient,
    chatId: recipient,
    payload: payload
  };
}

async function handleSendButtonMessage(client, args = {}) {
  if (!client) throw new Error('WaClient is not initialized');
  const to = args.to || args.chatId || args.recipient || args.jid;
  return await sendButtonMessage(client, to, args);
}

function setupButtonFlow(client, bridge, options = {}) {
  if (!bridge) return;

  const onCommand = async (args) => {
    try {
      return await handleSendButtonMessage(client, args);
    } catch (err) {
      console.error('[ButtonFlow] Error executing send_button_message:', err);
      throw err;
    }
  };

  if (typeof bridge.on === 'function') {
    bridge.on('send_button_message', onCommand);
    bridge.on('sendbuttonmessage', onCommand);
  }
}

// -----------------------------------------------------------------------------
// 5. Runnable Self-Check (Zero-framework verification)
// -----------------------------------------------------------------------------

function runSelfCheck() {
  const assert = require('assert');
  console.log('[ButtonFlow] Running self-check...');

  // 1. Verify quick_reply serialization
  const qrBtn = serializeNativeFlowButton({
    type: 'quick_reply',
    display_text: 'Accept',
    id: 'btn_yes'
  });
  assert.strictEqual(qrBtn.name, 'quick_reply');
  assert.strictEqual(qrBtn.buttonParamsJson, JSON.stringify({ display_text: 'Accept', id: 'btn_yes' }));
  console.log('  [PASS] 1. quick_reply serialization verified.');

  // 2. Verify cta_url serialization
  const urlBtn = serializeNativeFlowButton({
    type: 'cta_url',
    display_text: 'Open Link',
    url: 'https://whatsapp.com'
  });
  assert.strictEqual(urlBtn.name, 'cta_url');
  assert.strictEqual(urlBtn.buttonParamsJson, JSON.stringify({ display_text: 'Open Link', url: 'https://whatsapp.com' }));
  console.log('  [PASS] 2. cta_url serialization verified.');

  // 3. Verify cta_copy serialization
  const copyBtn = serializeNativeFlowButton({
    type: 'cta_copy',
    display_text: 'Promo',
    copy_code: 'ZAP2026'
  });
  assert.strictEqual(copyBtn.name, 'cta_copy');
  assert.strictEqual(copyBtn.buttonParamsJson, JSON.stringify({ display_text: 'Promo', copy_code: 'ZAP2026' }));
  console.log('  [PASS] 3. cta_copy serialization verified.');

  // 4. Verify full Proto.IMessage construction wrapped in viewOnceMessage
  const payload = constructProtoMessage({
    text: 'Please select an option:',
    header: 'Header Title',
    footer: 'Footer Text',
    buttons: [
      { type: 'quick_reply', display_text: 'Accept', id: 'btn_yes' },
      { type: 'cta_url', display_text: 'Visit', url: 'https://zapapp.im' },
      { type: 'cta_copy', display_text: 'Coupon', copy_code: 'ZAP50' }
    ]
  });

  assert(payload.viewOnceMessage, 'Payload must be wrapped inside viewOnceMessage');
  assert(payload.viewOnceMessage.message, 'viewOnceMessage must contain inner message');
  const innerMsg = payload.viewOnceMessage.message.interactiveMessage;
  assert(innerMsg, 'Inner message must contain interactiveMessage');
  assert.strictEqual(innerMsg.body.text, 'Please select an option:');
  assert.strictEqual(innerMsg.header.title, 'Header Title');
  assert.strictEqual(innerMsg.footer.text, 'Footer Text');
  assert.strictEqual(innerMsg.nativeFlowMessage.buttons.length, 3);
  assert.strictEqual(innerMsg.nativeFlowMessage.messageVersion, 3);
  console.log('  [PASS] 4. Proto.IMessage interactiveMessage wrapped in viewOnceMessage verified.');

  // 5. Verify protobuf encode / decode with zapo proto
  const proto = resolveProto();
  if (proto && proto.Message) {
    const encoded = proto.Message.encode(payload).finish();
    assert(encoded.length > 0, 'Protobuf encode must produce non-empty buffer');
    const decoded = proto.Message.decode(encoded);
    assert(decoded.viewOnceMessage, 'Decoded message must preserve viewOnceMessage');
    const decInteractive = decoded.viewOnceMessage.message.interactiveMessage;
    assert.strictEqual(decInteractive.body.text, 'Please select an option:');
    assert.strictEqual(decInteractive.nativeFlowMessage.buttons.length, 3);
    console.log('  [PASS] 5. Protobuf encode / decode bitstream verified with zapo-bundle.');
  }

  // 6. Verify client.message.send invocation
  let captured = null;
  const mockClient = {
    message: {
      send: async (to, sentPayload, opts) => {
        captured = { to, sentPayload, opts };
        return { id: '3EB0_MOCK_123' };
      }
    }
  };

  handleSendButtonMessage(mockClient, {
    to: '628111111111@s.whatsapp.net',
    text: 'Test button message',
    buttons: [
      { type: 'quick_reply', display_text: 'Confirm', id: 'c1' }
    ]
  }).then((res) => {
    assert.strictEqual(res.status, 'ok');
    assert.strictEqual(res.id, '3EB0_MOCK_123');
    assert.strictEqual(captured.to, '628111111111@s.whatsapp.net');
    assert(captured.sentPayload.viewOnceMessage, 'Sent payload must have viewOnceMessage wrapper');
    console.log('  [PASS] 6. client.message.send dispatched cleanly.');
    console.log('[ButtonFlow] All self-checks passed successfully.');
  }).catch((err) => {
    console.error('[ButtonFlow] Self-check failed:', err);
    process.exit(1);
  });
}

if (require.main === module) {
  runSelfCheck();
}

module.exports = {
  BUTTON_TYPES,
  serializeNativeFlowButton,
  serializeQuickReply,
  serializeCtaUrl,
  serializeCtaCopy,
  parseButtons,
  buildInteractiveMessage,
  wrapInViewOnce,
  constructProtoMessage,
  sendButtonMessage,
  handleSendButtonMessage,
  setupButtonFlow,
  resolveProto
};
