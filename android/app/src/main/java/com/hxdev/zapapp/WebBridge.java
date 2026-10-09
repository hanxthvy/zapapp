// [xihanzu-NR]
package com.hxdev.zapapp;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.lang.ref.WeakReference;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * JavaScriptInterface Bridge for Android WebView (window.ZapNative, window.ZapBridge, window.Android).
 * Handles inbound JS-to-Native calls (sendMessage, sendButtonMessage, pair, clipboard, URL launching)
 * and dispatches outbound Native / NodeRunner events back to the JavaScript runtime.
 */
public class WebBridge implements NativeZapCore.EventListener, NodeRunner.EventListener {
    private static final String TAG = "ZapWebBridge";

    private final WeakReference<Context> contextRef;
    private final WeakReference<WebView> webViewRef;
    private final Handler mainHandler;
    private final ExecutorService executor;

    // Deduplication caches for high-frequency bridge dispatches
    private volatile String lastDispatchedQr = null;
    private volatile long lastQrTimestamp = 0;
    private volatile String lastDispatchedCode = null;
    private volatile long lastCodeTimestamp = 0;
    private volatile String lastDispatchedState = null;
    private volatile long lastStateTimestamp = 0;

    public WebBridge(Context context, WebView webView) {
        this.contextRef = new WeakReference<>(context != null ? context.getApplicationContext() : null);
        this.webViewRef = new WeakReference<>(webView);
        this.mainHandler = new Handler(Looper.getMainLooper());
        this.executor = Executors.newSingleThreadExecutor();

        NativeZapCore.addListener(this);
        NodeRunner.addEventListener(this);
    }

    public void detach() {
        NativeZapCore.removeListener(this);
        NodeRunner.removeEventListener(this);
        executor.shutdown();
    }

    /**
     * Replays the most recently cached QR / pairing code / state into the WebView.
     * Called from onPageFinished: a QR emitted by NodeRunner before the page finished
     * loading would otherwise be lost, leaving the UI stuck on its loading spinner.
     */
    public void replayToWebView() {
        final String qr = lastDispatchedQr;
        final String code = lastDispatchedCode;
        final String state = lastDispatchedState;
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                WebView wv = webViewRef.get();
                if (wv == null) return;
                if (qr != null && !qr.isEmpty()) {
                    wv.evaluateJavascript(
                        "(function(){ if(typeof window.onQrReceived === 'function') window.onQrReceived("
                            + JSONObject.quote(qr) + "); })();", null);
                }
                if (code != null && !code.isEmpty()) {
                    wv.evaluateJavascript(
                        "(function(){ if(typeof window.onPairingCodeReceived === 'function') window.onPairingCodeReceived("
                            + JSONObject.quote(code) + "); })();", null);
                }
                if (state != null && !state.isEmpty()) {
                    wv.evaluateJavascript(
                        "(function(){ if(typeof window.onPairingStateUpdate === 'function') window.onPairingStateUpdate("
                            + JSONObject.quote(state) + "); })();", null);
                }
            }
        });
    }

    // -------------------------------------------------------------------------
    // Core JS-to-Native Bridge Handlers
    // -------------------------------------------------------------------------

    @JavascriptInterface
    public String sendMessage(final String jsonStr) {
        Log.d(TAG, "sendMessage called from JS: " + jsonStr);
        try {
            final JSONObject json = new JSONObject(jsonStr);
            final String msgId = json.optString("id", "msg_" + System.currentTimeMillis());
            final String chatId = json.optString("chatId", "status@broadcast");
            final String text = json.optString("text", "");

            executor.execute(new Runnable() {
                @Override
                public void run() {
                    String nativeResult = NativeZapCore.sendMessage(chatId, text);
                    Log.d(TAG, "NativeZapCore.sendMessage result: " + nativeResult);

                    mainHandler.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            dispatchMessageStatus(msgId, "sent");
                        }
                    }, 100);

                    mainHandler.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            dispatchMessageStatus(msgId, "delivered");
                        }
                    }, 600);
                }
            });

            JSONObject res = new JSONObject();
            res.put("status", "ok");
            res.put("id", msgId);
            return res.toString();
        } catch (Exception e) {
            Log.e(TAG, "sendMessage JSON error", e);
            return "{\"status\":\"error\",\"message\":\"" + e.getMessage() + "\"}";
        }
    }

    @JavascriptInterface
    public String sendButtonMessage(final String to, final String text, final String buttonsJson) {
        Log.d(TAG, "sendButtonMessage called from JS: to=" + to + " text=" + text + " buttons=" + buttonsJson);
        try {
            final String targetJid = to != null && !to.isEmpty() ? to : "status@broadcast";
            final String bodyText = text != null ? text : "";
            final String btns = buttonsJson != null ? buttonsJson : "[]";

            executor.execute(new Runnable() {
                @Override
                public void run() {
                    // Route directly to NodeRunner IPC
                    NodeRunner.sendButtonMessage(targetJid, bodyText, btns, new NodeRunner.IpcCallback() {
                        @Override
                        public void onResponse(boolean success, JSONObject response) {
                            Log.d(TAG, "NodeRunner.sendButtonMessage response success=" + success + ": " + response);
                            if (!success) {
                                // Fallback to NativeZapCore if NodeRunner IPC unavailable
                                String fallbackId = NativeZapCore.sendButtonMessage(targetJid, bodyText, btns);
                                Log.d(TAG, "NativeZapCore.sendButtonMessage fallback result id=" + fallbackId);
                            }
                        }
                    });
                }
            });

            return "{\"status\":\"ok\"}";
        } catch (Exception e) {
            Log.e(TAG, "sendButtonMessage error", e);
            return "{\"status\":\"error\",\"message\":\"" + e.getMessage() + "\"}";
        }
    }

    @JavascriptInterface
    public String sendButtonMessage(final String jsonStr) {
        Log.d(TAG, "sendButtonMessage single argument called from JS: " + jsonStr);
        try {
            JSONObject json = new JSONObject(jsonStr);
            String to = json.optString("to", json.optString("chatId", ""));
            String text = json.optString("text", json.optString("body", ""));
            String btns;
            if (json.has("buttons")) {
                btns = json.opt("buttons").toString();
            } else {
                btns = "[]";
            }
            return sendButtonMessage(to, text, btns);
        } catch (Exception e) {
            return sendButtonMessage(jsonStr, "", "[]");
        }
    }

    @JavascriptInterface
    public String onRequestPairingCode(final String jsonStr) {
        Log.d(TAG, "onRequestPairingCode: " + jsonStr);
        try {
            JSONObject req = new JSONObject(jsonStr);
            String phone = req.optString("phoneNumber", req.optString("phone", ""));
            NodeRunner.requestPairingCode(phone, new NodeRunner.IpcCallback() {
                @Override
                public void onResponse(boolean success, JSONObject response) {
                    if (success && response != null) {
                        String code = response.optString("code", "");
                        if (!code.isEmpty()) {
                            dispatchPairingCodeReceived(code);
                        }
                    }
                }
            });
            return "{\"status\":\"pending\"}";
        } catch (Exception e) {
            Log.e(TAG, "onRequestPairingCode error", e);
            return "{\"status\":\"error\",\"message\":\"" + e.getMessage() + "\"}";
        }
    }

    @JavascriptInterface
    public String onRequestQr(final String jsonStr) {
        Log.d(TAG, "onRequestQr: " + jsonStr);
        try {
            NodeRunner.sendCommand("request_qr", new JSONObject(), null);
            return "{\"status\":\"pending\"}";
        } catch (Exception e) {
            return "{\"status\":\"error\"}";
        }
    }

    @JavascriptInterface
    public String connect(final String serverUrl, final String sessionJson) {
        Log.i(TAG, "connect called from JS bridge.");
        executor.execute(new Runnable() {
            @Override
            public void run() {
                boolean success = NativeZapCore.connect(
                    serverUrl != null ? serverUrl : "",
                    sessionJson != null ? sessionJson : ""
                );
                Log.i(TAG, "NativeZapCore.connect result: " + success);
            }
        });
        return "{\"status\":\"connecting\"}";
    }

    @JavascriptInterface
    public String disconnect() {
        Log.i(TAG, "disconnect called from JS bridge.");
        executor.execute(new Runnable() {
            @Override
            public void run() {
                NodeRunner.disconnectWa(null);
                boolean success = NativeZapCore.disconnect();
                Log.i(TAG, "NativeZapCore.disconnect result: " + success);
            }
        });
        return "{\"status\":\"ok\"}";
    }

    @JavascriptInterface
    public void copyToClipboard(String text) {
        Context context = contextRef.get();
        if (context == null || text == null) return;
        try {
            ClipboardManager cm = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) {
                ClipData clip = ClipData.newPlainText("ZapApp", text);
                cm.setPrimaryClip(clip);
                Log.d(TAG, "Copied text to clipboard: " + text);
            }
        } catch (Exception e) {
            Log.e(TAG, "copyToClipboard error", e);
        }
    }

    @JavascriptInterface
    public void openUrl(String url) {
        Context context = contextRef.get();
        if (context == null || url == null) return;
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } catch (Exception e) {
            Log.e(TAG, "openUrl error: " + url, e);
        }
    }

    // -------------------------------------------------------------------------
    // In-App Diagnostics (readable from the WebView without ADB)
    // -------------------------------------------------------------------------

    /** Last N lines of engine log captured in-process by NodeRunner. */
    @JavascriptInterface
    public String getRuntimeLogs() {
        try {
            return NodeRunner.getRuntimeLogTail();
        } catch (Exception e) {
            return "[log unavailable] " + e.getMessage();
        }
    }

    /** Live engine status: library load, thread state, IPC socket, last event. */
    @JavascriptInterface
    public String getEngineStatus() {
        try {
            return NodeRunner.getEngineStatus().toString();
        } catch (Exception e) {
            return "{\"error\":\"" + e.getMessage() + "\"}";
        }
    }

    /** Clears the in-process engine log buffer. */
    @JavascriptInterface
    public void clearRuntimeLogs() {
        try {
            NodeRunner.clearRuntimeLog();
        } catch (Exception ignored) {}
    }

    // -------------------------------------------------------------------------
    // NodeRunner EventListener Implementation
    // -------------------------------------------------------------------------

    @Override
    public void onEvent(final String event, final JSONObject data) {
        if (event == null || data == null) return;
        try {
            if ("qr_live".equals(event) || "auth_qr".equals(event)) {
                String qr = data.optString("svg", "");
                if (qr.isEmpty()) {
                    qr = data.optString("qr", data.optString("payload", ""));
                }
                if (!qr.isEmpty()) {
                    dispatchQrReceived(qr);
                }
            } else if ("pairing_code_live".equals(event) || "auth_pairing_code".equals(event)) {
                String code = data.optString("formattedCode", "");
                if (code.isEmpty()) {
                    code = data.optString("code", "");
                }
                if (!code.isEmpty()) {
                    dispatchPairingCodeReceived(code);
                }
            } else if ("auth_paired".equals(event)) {
                dispatchPairingStateUpdate("paired");
            } else if ("connection".equals(event)) {
                String status = data.optString("status", "");
                if ("open".equalsIgnoreCase(status) || "connected".equalsIgnoreCase(status) || "paired".equalsIgnoreCase(status)) {
                    dispatchPairingStateUpdate("paired");
                }
            } else if ("message".equals(event)) {
                String chatId = data.optString("chatId", "");
                String id = data.optString("id", "");
                String text = data.optString("text", data.optString("content", ""));
                String type = data.optString("type", "text");
                long ts = data.optLong("timestamp", System.currentTimeMillis());
                dispatchIncomingMessage(chatId, id, text, type, ts);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling NodeRunner event: " + event, e);
        }
    }

    // -------------------------------------------------------------------------
    // Outbound Native-to-JS Event Dispatchers
    // -------------------------------------------------------------------------

    public void dispatchQrReceived(final String qrSvgOrString) {
        if (qrSvgOrString == null || qrSvgOrString.isEmpty()) return;
        long now = System.currentTimeMillis();
        if (qrSvgOrString.equals(lastDispatchedQr) && (now - lastQrTimestamp < 500)) {
            return;
        }
        lastDispatchedQr = qrSvgOrString;
        lastQrTimestamp = now;

        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                WebView wv = webViewRef.get();
                if (wv == null) return;
                String script = String.format(
                    "(function(){ if(typeof window.onQrReceived === 'function') window.onQrReceived(%s); })();",
                    JSONObject.quote(qrSvgOrString)
                );
                wv.evaluateJavascript(script, null);
            }
        });
    }

    public void dispatchPairingCodeReceived(final String code) {
        if (code == null || code.isEmpty()) return;
        long now = System.currentTimeMillis();
        if (code.equals(lastDispatchedCode) && (now - lastCodeTimestamp < 500)) {
            return;
        }
        lastDispatchedCode = code;
        lastCodeTimestamp = now;

        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                WebView wv = webViewRef.get();
                if (wv == null) return;
                String script = String.format(
                    "(function(){ if(typeof window.onPairingCodeReceived === 'function') window.onPairingCodeReceived(%s); })();",
                    JSONObject.quote(code)
                );
                wv.evaluateJavascript(script, null);
            }
        });
    }

    public void dispatchPairingStateUpdate(final String state) {
        final String effectiveState = (state != null && !state.isEmpty()) ? state : "paired";
        long now = System.currentTimeMillis();
        if (effectiveState.equals(lastDispatchedState) && (now - lastStateTimestamp < 500)) {
            return;
        }
        lastDispatchedState = effectiveState;
        lastStateTimestamp = now;

        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                WebView wv = webViewRef.get();
                if (wv == null) return;
                String script = String.format(
                    "(function(){ if(typeof window.onPairingStateUpdate === 'function') window.onPairingStateUpdate(%s); })();",
                    JSONObject.quote(effectiveState)
                );
                wv.evaluateJavascript(script, null);
            }
        });
    }

    public void dispatchMessageStatus(final String messageId, final String status) {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                WebView wv = webViewRef.get();
                if (wv == null) return;
                String script = String.format(
                    "(function(){ if(typeof window.onMessageStatusUpdate === 'function') window.onMessageStatusUpdate(%s,%s); })();",
                    JSONObject.quote(messageId != null ? messageId : ""),
                    JSONObject.quote(status != null ? status : "")
                );
                wv.evaluateJavascript(script, null);
            }
        });
    }

    public void dispatchIncomingMessage(final String chatId, final String id, final String text, final String type, final long timestamp) {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                WebView wv = webViewRef.get();
                if (wv == null) return;
                try {
                    JSONObject msg = new JSONObject();
                    msg.put("chatId", chatId != null ? chatId : "");
                    msg.put("id", id != null ? id : "");
                    msg.put("text", text != null ? text : "");
                    msg.put("type", type != null ? type : "text");
                    msg.put("fromMe", false);
                    msg.put("timestamp", timestamp);

                    String script = String.format(
                        "(function(){ if(typeof window.onReceiveMessage === 'function') window.onReceiveMessage(%s); })();",
                        msg.toString()
                    );
                    wv.evaluateJavascript(script, null);
                } catch (Exception e) {
                    Log.e(TAG, "Error dispatching incoming message", e);
                }
            }
        });
    }

    // -------------------------------------------------------------------------
    // NativeZapCore.EventListener Implementation
    // -------------------------------------------------------------------------

    @Override
    public void onMessageReceived(String chatId, String messageId, String text, String type, long timestamp) {
        dispatchIncomingMessage(chatId, messageId, text, type, timestamp);
    }

    @Override
    public void onMessageStatusChanged(String messageId, String status) {
        dispatchMessageStatus(messageId, status);
    }

    @Override
    public void onQrReceived(final String qrString) {
        dispatchQrReceived(qrString);
    }

    @Override
    public void onPairingStateChanged(final String state, final String details) {
        if ("paired".equalsIgnoreCase(state) || "open".equalsIgnoreCase(state) || "connected".equalsIgnoreCase(state)) {
            dispatchPairingStateUpdate("paired");
        } else if ("pairing_code".equalsIgnoreCase(state) && details != null && !details.isEmpty()) {
            dispatchPairingCodeReceived(details);
        } else {
            dispatchPairingStateUpdate(state);
        }
    }
}
