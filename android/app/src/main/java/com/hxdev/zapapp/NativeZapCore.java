// [xihanzu-NR]
package com.hxdev.zapapp;

import android.util.Log;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * JNI Native Bridge to Rust zapapp_core engine.
 * Provides high-performance cryptographic operations, SQLite storage,
 * and WhatsApp interactive messaging.
 */
public final class NativeZapCore {
    private static final String TAG = "NativeZapCore";

    static {
        try {
            System.loadLibrary("zapapp_core");
            Log.i(TAG, "Native library 'zapapp_core' loaded successfully.");
        } catch (UnsatisfiedLinkError e) {
            Log.e(TAG, "Failed to load native library 'zapapp_core'", e);
        }
    }

    public interface EventListener {
        void onMessageReceived(String chatId, String messageId, String text, String type, long timestamp);
        void onMessageStatusChanged(String messageId, String status);
        void onQrReceived(String qrString);
        void onPairingStateChanged(String state, String details);
    }

    private static final List<EventListener> listeners = new CopyOnWriteArrayList<>();

    private NativeZapCore() {}

    public static void addListener(EventListener listener) {
        if (listener != null) {
            listeners.add(listener);
        }
    }

    public static void removeListener(EventListener listener) {
        if (listener != null) {
            listeners.remove(listener);
        }
    }

    // Native JNI Methods
    public static native boolean init(String dbPath);
    public static native boolean connect(String serverUrl, String sessionJson);
    public static native String sendMessage(String to, String text);
    public static native String sendButtonMessage(String to, String text, String buttonsJson);
    public static native boolean disconnect();

    // Native to Java callbacks
    public static void dispatchMessage(String chatId, String messageId, String text, String type, long timestamp) {
        for (EventListener l : listeners) {
            try {
                l.onMessageReceived(chatId, messageId, text, type, timestamp);
            } catch (Exception e) {
                Log.e(TAG, "Error in event listener onMessageReceived", e);
            }
        }
    }

    public static void dispatchStatus(String messageId, String status) {
        for (EventListener l : listeners) {
            try {
                l.onMessageStatusChanged(messageId, status);
            } catch (Exception e) {
                Log.e(TAG, "Error in event listener onMessageStatusChanged", e);
            }
        }
    }

    public static void dispatchQr(String qrString) {
        for (EventListener l : listeners) {
            try {
                l.onQrReceived(qrString);
            } catch (Exception e) {
                Log.e(TAG, "Error in event listener onQrReceived", e);
            }
        }
    }

    public static void dispatchPairingState(String state, String details) {
        for (EventListener l : listeners) {
            try {
                l.onPairingStateChanged(state, details);
            } catch (Exception e) {
                Log.e(TAG, "Error in event listener onPairingStateChanged", e);
            }
        }
    }
}
