// [xihanzu-NR]
package com.hxdev.zapapp

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log

/**
 * Sticky Foreground Service for ZapApp.
 * Ensures background connection resiliency with:
 * - START_STICKY process lifecycle management
 * - Ongoing foreground notification
 * - Partial WakeLock to prevent CPU sleep during background sync
 */
class ZapForegroundService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null
    private var connectivityManager: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "ZapForegroundService onCreate initialized.")
        createNotificationChannel()
        initWakeLock()
        registerNetworkCallback()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START
        Log.d(TAG, "onStartCommand received action: $action, startId: $startId")

        when (action) {
            ACTION_STOP -> {
                Log.i(TAG, "Stopping foreground service requested via action.")
                stopServiceGracefully()
                return START_NOT_STICKY
            }
            ACTION_RECONNECT -> {
                Log.d(TAG, "Reconnecting background worker...")
                acquireWakeLock(TRANSIENT_WAKELOCK_TIMEOUT_MS)
            }
            ACTION_START -> {
                Log.i(TAG, "Starting sticky foreground service and notification.")
                startForegroundNotification()
                acquireWakeLock()
                isRunning = true
            }
            else -> {
                startForegroundNotification()
                acquireWakeLock()
                isRunning = true
            }
        }

        // START_STICKY: Ensures service restarts automatically if terminated by system
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? {
        return null
    }

    override fun onDestroy() {
        Log.i(TAG, "ZapForegroundService onDestroy tearing down resources.")
        isRunning = false
        releaseWakeLock()
        unregisterNetworkCallback()
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            val channel = NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = CHANNEL_DESC
                setShowBadge(false)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            notificationManager?.createNotificationChannel(channel)
            Log.d(TAG, "NotificationChannel created: $CHANNEL_ID")
        }
    }

    private fun startForegroundNotification() {
        val notification = buildOngoingNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        Log.d(TAG, "Service promoted to foreground with notification id: $NOTIFICATION_ID")
    }

    private fun buildOngoingNotification(): Notification {
        val pendingIntentFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }

        // PendingIntent to stop the foreground service
        val stopIntent = Intent(this, ZapForegroundService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPendingIntent = PendingIntent.getService(this, REQUEST_CODE_STOP, stopIntent, pendingIntentFlags)

        // PendingIntent to launch the main app if available
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val contentPendingIntent = launchIntent?.let {
            PendingIntent.getActivity(this, REQUEST_CODE_MAIN, it, pendingIntentFlags)
        }

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        val iconRes = if (applicationInfo.icon != 0) applicationInfo.icon else android.R.drawable.stat_notify_sync

        builder.setContentTitle(NOTIFICATION_TITLE)
            .setContentText(NOTIFICATION_TEXT)
            .setSmallIcon(iconRes)
            .setOngoing(true)
            .setAutoCancel(false)

        contentPendingIntent?.let { builder.setContentIntent(it) }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            builder.setCategory(Notification.CATEGORY_SERVICE)
            builder.setVisibility(Notification.VISIBILITY_PUBLIC)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder.setColor(COLOR_WHATSAPP_TEAL)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT_WATCH) {
            val stopAction = Notification.Action.Builder(
                android.R.drawable.ic_menu_close_clear_cancel,
                "Disconnect",
                stopPendingIntent
            ).build()
            builder.addAction(stopAction)
        }

        return builder.build()
    }

    private fun initWakeLock() {
        if (wakeLock == null) {
            val powerManager = getSystemService(Context.POWER_SERVICE) as? PowerManager
            wakeLock = powerManager?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG)?.apply {
                setReferenceCounted(false)
            }
        }
    }

    private fun acquireWakeLock(timeoutMs: Long? = null) {
        try {
            initWakeLock()
            wakeLock?.let { lock ->
                if (!lock.isHeld) {
                    if (timeoutMs != null && timeoutMs > 0) {
                        lock.acquire(timeoutMs)
                        Log.d(TAG, "Acquired Partial WakeLock with timeout: $timeoutMs ms")
                    } else {
                        lock.acquire()
                        Log.d(TAG, "Acquired Partial WakeLock (indefinite)")
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to acquire Partial WakeLock", e)
        }
    }

    private fun releaseWakeLock() {
        try {
            wakeLock?.let { lock ->
                if (lock.isHeld) {
                    lock.release()
                    Log.d(TAG, "Released Partial WakeLock")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to release Partial WakeLock", e)
        }
    }

    private fun registerNetworkCallback() {
        try {
            connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && connectivityManager != null) {
                networkCallback = object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) {
                        Log.i(TAG, "Network available. Refreshing connection heartbeat.")
                        acquireWakeLock(TRANSIENT_WAKELOCK_TIMEOUT_MS)
                    }

                    override fun onLost(network: Network) {
                        Log.w(TAG, "Network lost. Waiting for connection recovery.")
                    }
                }
                connectivityManager?.registerDefaultNetworkCallback(networkCallback!!)
                Log.d(TAG, "Registered default network callback for connectivity resilience.")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not register default network callback", e)
        }
    }

    private fun unregisterNetworkCallback() {
        networkCallback?.let { callback ->
            try {
                connectivityManager?.unregisterNetworkCallback(callback)
                Log.d(TAG, "Unregistered network callback.")
            } catch (e: Exception) {
                Log.w(TAG, "Error unregistering network callback", e)
            }
            networkCallback = null
        }
    }

    private fun stopServiceGracefully() {
        isRunning = false
        releaseWakeLock()
        unregisterNetworkCallback()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
        Log.i(TAG, "ZapForegroundService stopped successfully.")
    }

    companion object {
        private const val TAG = "ZapForegroundService"
        private const val WAKELOCK_TAG = "ZapApp:ForegroundWakeLock"

        const val CHANNEL_ID = "zap_foreground_service_channel"
        const val CHANNEL_NAME = "ZapApp Background Service"
        const val CHANNEL_DESC = "Maintains continuous connection for ZapApp in background"
        const val NOTIFICATION_ID = 2026

        const val ACTION_START = "com.hxdev.zapapp.action.START"
        const val ACTION_STOP = "com.hxdev.zapapp.action.STOP"
        const val ACTION_RECONNECT = "com.hxdev.zapapp.action.RECONNECT"

        private const val REQUEST_CODE_MAIN = 100
        private const val REQUEST_CODE_STOP = 101
        private const val TRANSIENT_WAKELOCK_TIMEOUT_MS = 15000L
        private const val COLOR_WHATSAPP_TEAL = 0xFF00A884.toInt()

        private const val NOTIFICATION_TITLE = "ZapApp Active"
        private const val NOTIFICATION_TEXT = "Maintaining background connection..."

        @Volatile
        var isRunning: Boolean = false
            private set

        /**
         * Starts the sticky foreground service.
         * Handles Android 8.0+ startForegroundService requirement.
         */
        @JvmStatic
        fun start(context: Context) {
            val intent = Intent(context, ZapForegroundService::class.java).apply {
                action = ACTION_START
            }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
                Log.i(TAG, "ZapForegroundService start intent dispatched.")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start ZapForegroundService", e)
            }
        }

        /**
         * Stops the foreground service.
         */
        @JvmStatic
        fun stop(context: Context) {
            val intent = Intent(context, ZapForegroundService::class.java).apply {
                action = ACTION_STOP
            }
            try {
                context.startService(intent)
                Log.i(TAG, "ZapForegroundService stop intent dispatched.")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to stop ZapForegroundService", e)
            }
        }
    }
}
