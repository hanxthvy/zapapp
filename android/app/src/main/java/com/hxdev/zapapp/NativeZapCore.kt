// [xihanzu-NR]
package com.hxdev.zapapp

import android.util.Log

/**
 * JNI Native Bridge to Rust zapapp_core engine.
 * Provides high-performance cryptographic operations, SQLite storage,
 * and WhatsApp interactive messaging.
 */
object NativeZapCore {
    private const val TAG = "NativeZapCore"

    init {
        try {
            System.loadLibrary("zapapp_core")
            Log.i(TAG, "Native library 'zapapp_core' loaded successfully.")
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "Failed to load native library 'zapapp_core'", e)
        }
    }

    /**
     * Initializes the native ZapCore engine with local database storage.
     * @param dbPath Absolute path to SQLite database file.
     * @return true if initialized successfully, false otherwise.
     */
    @JvmStatic
    external fun init(dbPath: String): Boolean

    /**
     * Connects to WhatsApp WebSocket gateway.
     * @param serverUrl Gateway WebSocket URL or empty for default.
     * @param sessionJson Serialized session/credentials JSON.
     * @return true if connection established, false otherwise.
     */
    @JvmStatic
    external fun connect(serverUrl: String, sessionJson: String): Boolean

    /**
     * Sends a plain text message to recipient.
     * @param to Target JID (e.g. 628123456789@s.whatsapp.net).
     * @param text Message body text.
     * @return Unique message ID string.
     */
    @JvmStatic
    external fun sendMessage(to: String, text: String): String?

    /**
     * Sends an interactive button message (Quick Reply, CTA URL, CTA Copy) wrapped as ViewOnce.
     * @param to Target JID.
     * @param text Message body text.
     * @param buttonsJson Serialized JSON array of buttons.
     * @return Unique message ID string.
     */
    @JvmStatic
    external fun sendButtonMessage(to: String, text: String, buttonsJson: String): String?

    /**
     * Disconnects the active network session and releases connection resources.
     * @return true if disconnected cleanly.
     */
    @JvmStatic
    external fun disconnect(): Boolean
}
