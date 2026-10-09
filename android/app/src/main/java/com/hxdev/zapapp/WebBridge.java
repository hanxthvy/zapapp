// [xihanzu-NR]
package com.hxdev.zapapp;

import android.content.ClipData
;import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import org.json.JSONObject;
import java.lang.ref.WeakReference;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * JavaScriptInterface Bridge for Android WebView (window.ZapNative, window.ZapBridge, window.Android).
 * Handles inbound JS-to-Native calls (sendMessage, pair, getStatus, clipboard, URL launching)
 * and dispatches outbound Native events back to the JavaScript runtime via evaluateJavascript.
 */
public class WebBridge implements NativeZapCore.EventListener {
    private static final String TAG = "ZapWebBridge";

    private final WeakReference<Context> contextRef;
    private final WeakReference<WebView> webViewRef;
    private final Handler mainHandler;
    private final ExecutorService executor;

    public WebBridge(Context context, WebView webView) {
        this.contextRef = new WeakReference<>(context != null ? context.getApplicationContext() : null);
        this.webViewRef = new WeakReference<>(webView);
        this.mainHandler = new Handler(Looper.getMainLooper());
        this.executor = Executors.newSingleThreadExecutor();

        NativeZapCore.addListener(this);
    }

    public void detach() {
        NativeZapCore.removeListener(this);
        executor.shutdown();
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
                    String msgId = NativeZapCore.sendButtonMessage(targetJid, bodyText, btns);
                    Log.d(TAG, "NativeZapCore.sendButtonMessage result id=" + msgId);
                }
            });

            return "{\"status\":\"ok\"}";
        } catch (Exception e) {
            Log.e(TAG, "sendButtonMessage error", e);
            return "{\"status\":\"error\",\"message\":\"" + e.getMessage() + "\"}";
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
    // Outbound Native-to-JS Event Dispatchers
    // -------------------------------------------------------------------------

    public void dispatchMessageStatus(final String messageId, final String status) {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                WebView wv = webViewRef.get();
                if (wv == null) return;
                String script = String.format(
                    "(function(){ if(window.onMessageStatusUpdate) window.onMessageStatusUpdate('%s','%s'); })();",
                    escapeJs(messageId), escapeJs(status)
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
                String script = String.format(
                    "(function(){ if(window.onReceiveMessage) window.onReceiveMessage({chatId:'%s',id:'%s',text:'%s',type:'%s',fromMe:false,timestamp:%d}); })();",
                    escapeJs(chatId), escapeJs(id), escapeJs(text), escapeJs(type), timestamp
                );
                wv.evaluateJavascript(script, null);
            }
        });
    }

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
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                WebView wv = webViewRef.get();
                if (wv == null) return;
                String script = String.format(
                    "(function(){ if(window.onQrReceived) window.onQrReceived('%s'); })();",
                    escapeJs(qrString)
                );
                wv.evaluateJavascript(script, null);
            }
        });
    }

    @Override
    public void onPairingStateChanged(final String state, final String details) {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                WebView wv = webViewRef.get();
                if (wv == null) return;
                String script = String.format(
                    "(function(){ if(window.onPairingStateUpdate) window.onPairingStateUpdate('%s','%s'); })();",
                    escapeJs(state), escapeJs(details)
                );
                wv.evaluateJavascript(script, null);
            }
        });
    }

    private static String escapeJs(String str) {
        if (str == null) return "";
        return str.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n").replace("\r", "");
    }
}
