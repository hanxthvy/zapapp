// [xihanzu-NR]
package com.hxdev.zapapp

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * JavaScriptInterface Bridge for Android WebView (window.ZapNative, window.ZapBridge, window.Android).
 * Handles inbound JS-to-Native calls (sendMessage, pair, getStatus, clipboard, URL launching)
 * and dispatches outbound Native events back to the JavaScript runtime via evaluateJavascript.
 */
class WebBridge(
    context: Context,
    webView: WebView
) : NativeZapCore.EventListener {

    private val contextRef = WeakReference(context.applicationContext)
    private val webViewRef = WeakReference(webView)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val executor: ExecutorService = Executors.newSingleThreadExecutor()

    init {
        NativeZapCore.addListener(this)
    }

    fun detach() {
        NativeZapCore.removeListener(this)
        executor.shutdown()
    }

    // -------------------------------------------------------------------------
    // Core JS-to-Native Bridge Handlers
    // -------------------------------------------------------------------------

    /**
     * Send an outbound chat message or interactive response.
     * Expects JSON: { id, chatId, text, type, replyToId, timestamp }
     */
    @JavascriptInterface
    fun sendMessage(jsonStr: String): String {
        Log.d(TAG, "sendMessage called from JS: $jsonStr")
        return try {
            val json = JSONObject(jsonStr)
            val msgId = json.optString("id", "msg_${System.currentTimeMillis()}")
            val chatId = json.optString("chatId", "status@broadcast")
            val text = json.optString("text", "")
            val replyToId = if (json.has("replyToId") && !json.isNull("replyToId")) {
                json.getString("replyToId")
            } else {
                null
            }

            executor.execute {
                val nativeResult = NativeZapCore.sendMessage(chatId, text, replyToId)
                Log.d(TAG, "NativeZapCore.sendMessage result: $nativeResult")

                // Immediately emit optimistic status updates back to WebView
                mainHandler.postDelayed({
                    dispatchMessageStatus(msgId, "sent")
                }, 100)

                mainHandler.postDelayed({
                    dispatchMessageStatus(msgId, "delivered")
                }, 600)
            }

            JSONObject().apply {
                put("status", "ok")
                put("id", msgId)
                put("chatId", chatId)
            }.toString()
        } catch (e: Exception) {
            Log.e(TAG, "Error in sendMessage bridge handler", e)
            JSONObject().apply {
                put("status", "error")
                put("error", e.message ?: "Unknown error")
            }.toString()
        }
    }

    /**
     * Start companion device pairing or verify pairing code.
     * Expects JSON: { method: "qr" | "phone", phoneNumber: "+...", code: "..." }
     */
    @JavascriptInterface
    fun pair(jsonStr: String): String {
        Log.d(TAG, "pair called from JS: $jsonStr")
        return try {
            val json = JSONObject(jsonStr)
            val method = json.optString("method", "qr")
            val phoneNumber = if (json.has("phoneNumber") && !json.isNull("phoneNumber")) {
                json.getString("phoneNumber")
            } else {
                null
            }
            val code = json.optString("code", "")

            if (code.isNotEmpty()) {
                val verified = NativeZapCore.confirmPairingCode(code)
                JSONObject().apply {
                    put("status", if (verified) "ok" else "failed")
                    put("verified", verified)
                }.toString()
            } else {
                val result = NativeZapCore.startPairing(method, phoneNumber)
                JSONObject().apply {
                    put("status", "ok")
                    put("result", JSONObject(result))
                }.toString()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error in pair bridge handler", e)
            JSONObject().apply {
                put("status", "error")
                put("error", e.message ?: "Pairing request failed")
            }.toString()
        }
    }

    /**
     * Retrieve WhatsApp client runtime connection and pairing status.
     */
    @JavascriptInterface
    fun getStatus(): String {
        Log.d(TAG, "getStatus called from JS")
        return try {
            NativeZapCore.getStatus()
        } catch (e: Exception) {
            Log.e(TAG, "Error in getStatus bridge handler", e)
            JSONObject().apply {
                put("status", "error")
                put("error", e.message ?: "Failed getting status")
            }.toString()
        }
    }

    // -------------------------------------------------------------------------
    // Auxiliary Handlers matching UI/SPA Bridge dispatches
    // -------------------------------------------------------------------------

    @JavascriptInterface
    fun onRequestQr(jsonStr: String): String {
        Log.d(TAG, "onRequestQr: $jsonStr")
        executor.execute {
            val pairingRes = NativeZapCore.startPairing("qr")
            try {
                val json = JSONObject(pairingRes)
                val qr = json.optString("payload", "2@mock_qr_token,pubkey,identity")
                val ttl = json.optLong("ttl", 60L)
                mainHandler.post {
                    dispatchQrReceived(qr, ttl)
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed parsing pairing response", e)
            }
        }
        return "{\"status\":\"pending\"}"
    }

    @JavascriptInterface
    fun onRequestPairingCode(jsonStr: String): String {
        Log.d(TAG, "onRequestPairingCode: $jsonStr")
        executor.execute {
            try {
                val req = JSONObject(jsonStr)
                val phone = req.optString("phoneNumber", "")
                val pairingRes = NativeZapCore.startPairing("phone", phone)
                val json = JSONObject(pairingRes)
                val code = json.optString("code", "ZAP8-2026")
                val ttl = json.optLong("ttl", 180L)
                mainHandler.post {
                    dispatchPairingCodeReceived(code, ttl)
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed handling onRequestPairingCode", e)
            }
        }
        return "{\"status\":\"pending\"}"
    }

    @JavascriptInterface
    fun onPairingStateChanged(jsonStr: String): String {
        Log.d(TAG, "onPairingStateChanged from JS: $jsonStr")
        return "{\"status\":\"ok\"}"
    }

    @JavascriptInterface
    fun onPairingCompleted(jsonStr: String): String {
        Log.i(TAG, "onPairingCompleted: $jsonStr")
        contextRef.get()?.let { ctx ->
            ZapForegroundService.start(ctx)
        }
        return "{\"status\":\"ok\"}"
    }

    @JavascriptInterface
    fun onSyncProgress(jsonStr: String): String {
        Log.d(TAG, "onSyncProgress from JS: $jsonStr")
        return "{\"status\":\"ok\"}"
    }

    @JavascriptInterface
    fun copyToClipboard(jsonStr: String): Boolean {
        return try {
            val json = JSONObject(jsonStr)
            val text = json.optString("text", "")
            val ctx = contextRef.get() ?: return false
            val clipboard = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            val clip = ClipData.newPlainText("ZapApp", text)
            clipboard?.setPrimaryClip(clip)
            Log.d(TAG, "Copied text to clipboard: $text")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to copy to clipboard", e)
            false
        }
    }

    @JavascriptInterface
    fun openUrl(jsonStr: String): Boolean {
        return try {
            val json = JSONObject(jsonStr)
            val url = json.optString("url", "")
            if (url.isEmpty()) return false
            val ctx = contextRef.get() ?: return false
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            ctx.startActivity(intent)
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to open URL", e)
            false
        }
    }

    @JavascriptInterface
    fun onQuickReplyClick(jsonStr: String): String {
        Log.d(TAG, "onQuickReplyClick: $jsonStr")
        return "{\"status\":\"ok\"}"
    }

    @JavascriptInterface
    fun pickAttachment(jsonStr: String): String {
        Log.d(TAG, "pickAttachment: $jsonStr")
        return "{\"status\":\"ok\"}"
    }

    @JavascriptInterface
    fun onVoiceNoteRecord(jsonStr: String): String {
        Log.d(TAG, "onVoiceNoteRecord: $jsonStr")
        return "{\"status\":\"ok\"}"
    }

    @JavascriptInterface
    fun onChatOpened(jsonStr: String): String {
        Log.d(TAG, "onChatOpened: $jsonStr")
        return "{\"status\":\"ok\"}"
    }

    @JavascriptInterface
    fun onChatClosed(jsonStr: String): String {
        Log.d(TAG, "onChatClosed: $jsonStr")
        return "{\"status\":\"ok\"}"
    }

    @JavascriptInterface
    fun dispatch(action: String, payloadJson: String): String {
        Log.d(TAG, "Generic dispatch: action=$action, payload=$payloadJson")
        return when (action) {
            "sendMessage" -> sendMessage(payloadJson)
            "pair" -> pair(payloadJson)
            "getStatus" -> getStatus()
            "onRequestQr" -> onRequestQr(payloadJson)
            "onRequestPairingCode" -> onRequestPairingCode(payloadJson)
            "copyToClipboard" -> if (copyToClipboard(payloadJson)) "{\"status\":\"ok\"}" else "{\"status\":\"error\"}"
            "openUrl" -> if (openUrl(payloadJson)) "{\"status\":\"ok\"}" else "{\"status\":\"error\"}"
            else -> "{\"status\":\"unhandled\",\"action\":\"$action\"}"
        }
    }

    // -------------------------------------------------------------------------
    // Outbound Native-to-JS Dispatches via evaluateJavascript
    // -------------------------------------------------------------------------

    override fun onEvent(event: String, payloadJson: String) {
        val script = "if (window.onNativeEvent) { window.onNativeEvent(${quoteJs(event)}, ${quoteJs(payloadJson)}); }"
        runJs(script)
    }

    override fun onMessageReceived(messageJson: String) {
        dispatchMessageReceived(messageJson)
    }

    override fun onMessageStatusChanged(msgId: String, status: String) {
        dispatchMessageStatus(msgId, status)
    }

    override fun onPairingStateChanged(state: String, payloadJson: String) {
        val script = """
            if (typeof window.onPairingStateUpdate === 'function') {
                window.onPairingStateUpdate(${quoteJs(payloadJson)});
            }
        """.trimIndent()
        runJs(script)
    }

    override fun onQrReceived(qrPayload: String, ttlSecs: Long) {
        val payloadObj = JSONObject().apply {
            put("payload", qrPayload)
            put("ttl", ttlSecs)
        }
        val script = """
            if (typeof window.onQrReceived === 'function') {
                window.onQrReceived(${quoteJs(payloadObj.toString())});
            }
        """.trimIndent()
        runJs(script)
    }

    override fun onPairingCodeReceived(code: String, ttlSecs: Long) {
        val payloadObj = JSONObject().apply {
            put("code", code)
            put("ttl", ttlSecs)
        }
        val script = """
            if (typeof window.onPairingCodeReceived === 'function') {
                window.onPairingCodeReceived(${quoteJs(payloadObj.toString())});
            }
        """.trimIndent()
        runJs(script)
    }

    override fun onSyncProgress(progress: Int) {
        val payloadObj = JSONObject().apply {
            put("progress", progress)
        }
        val script = """
            if (typeof window.onSyncProgressUpdate === 'function') {
                window.onSyncProgressUpdate(${quoteJs(payloadObj.toString())});
            }
        """.trimIndent()
        runJs(script)
    }

    override fun onConnectionStateChanged(status: String) {
        val script = """
            if (window.dispatchEvent) {
                window.dispatchEvent(new CustomEvent('zap:connection', { detail: { status: ${quoteJs(status)} } }));
            }
        """.trimIndent()
        runJs(script)
    }

    private fun dispatchMessageReceived(messageJson: String) {
        val script = """
            (function() {
                var payload = ${messageJson.ifEmpty { "{}" }};
                if (typeof window.onReceiveMessage === 'function') {
                    window.onReceiveMessage(payload);
                }
                if (window.dispatchEvent) {
                    window.dispatchEvent(new CustomEvent('zap:message', { detail: payload }));
                }
            })();
        """.trimIndent()
        runJs(script)
    }

    private fun dispatchMessageStatus(msgId: String, status: String) {
        val script = """
            (function() {
                var id = ${quoteJs(msgId)};
                var st = ${quoteJs(status)};
                if (typeof window.onMessageStatusUpdate === 'function') {
                    window.onMessageStatusUpdate(id, st);
                }
                if (typeof window.onMessageStatus === 'function') {
                    window.onMessageStatus(id, st);
                }
                if (window.dispatchEvent) {
                    window.dispatchEvent(new CustomEvent('zap:status', { detail: { id: id, status: st } }));
                }
            })();
        """.trimIndent()
        runJs(script)
    }

    private fun runJs(jsCode: String) {
        mainHandler.post {
            webViewRef.get()?.evaluateJavascript(jsCode, null)
        }
    }

    private fun quoteJs(str: String): String {
        return JSONObject.quote(str)
    }

    companion object {
        private const val TAG = "ZapWebBridge"
    }
}
