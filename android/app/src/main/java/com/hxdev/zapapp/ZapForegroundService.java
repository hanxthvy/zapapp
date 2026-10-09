// [xihanzu-NR]
package com.hxdev.zapapp;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import com.janeasystems.nodejs_mobile.NodeRunner;

/**
 * Sticky Foreground Service for ZapApp.
 * Ensures background connection resiliency with:
 * - START_STICKY process lifecycle management
 * - Embedded NodeRunner runtime initialization and continuous execution
 * - Active Partial WakeLock to prevent CPU sleep during background sync
 * - Continuous network connectivity monitoring and reconnection handling
 */
public class ZapForegroundService extends Service {
    private static final String TAG = "ZapForegroundService";
    private static final String WAKELOCK_TAG = "ZapApp:ForegroundWakeLock";

    public static final String CHANNEL_ID = "zap_foreground_service_channel";
    public static final String CHANNEL_NAME = "ZapApp Background Service";
    public static final String CHANNEL_DESC = "Maintains continuous connection for ZapApp in background";
    public static final int NOTIFICATION_ID = 2026;

    public static final String ACTION_START = "com.hxdev.zapapp.action.START";
    public static final String ACTION_STOP = "com.hxdev.zapapp.action.STOP";
    public static final String ACTION_RECONNECT = "com.hxdev.zapapp.action.RECONNECT";

    private static final int REQUEST_CODE_MAIN = 100;
    private static final int REQUEST_CODE_STOP = 101;
    private static final int COLOR_WHATSAPP_TEAL = 0xFF00A884;

    private static final String NOTIFICATION_TITLE = "ZapApp Active";
    private static final String NOTIFICATION_TEXT = "Maintaining background connection...";

    public static volatile boolean isRunning = false;
    public static volatile boolean isNetworkConnected = false;

    private PowerManager.WakeLock wakeLock;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;

    @Override
    public void onCreate() {
        super.onCreate();
        Log.i(TAG, "ZapForegroundService onCreate initialized.");
        createNotificationChannel();
        initWakeLock();
        acquireWakeLock();
        registerNetworkCallback();
        startNodeRunner();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;
        Log.d(TAG, "onStartCommand received action: " + action + ", startId: " + startId);

        if (ACTION_STOP.equals(action)) {
            Log.i(TAG, "Stopping foreground service requested via action.");
            stopServiceGracefully();
            return START_NOT_STICKY;
        }

        startForegroundNotification();
        acquireWakeLock();
        isRunning = true;

        startNodeRunner();

        if (ACTION_RECONNECT.equals(action)) {
            Log.d(TAG, "Reconnection requested. Ensuring WakeLock active and NodeRunner running.");
        }

        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "ZapForegroundService onDestroy tearing down resources.");
        isRunning = false;
        releaseWakeLock();
        unregisterNetworkCallback();
        super.onDestroy();
    }

    /**
     * Starts the embedded Node.js runtime via NodeRunner on a background thread.
     * Prevents blocking the service Looper during asset extraction and initialization.
     */
    private synchronized void startNodeRunner() {
        try {
            if (NodeRunner.isRunning()) {
                Log.d(TAG, "NodeRunner runtime is already running.");
                return;
            }
            Log.i(TAG, "Starting NodeRunner embedded runtime...");
            new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        Context appContext = getApplicationContext();
                        NodeRunner.startNode(appContext);
                        Log.i(TAG, "NodeRunner started successfully.");
                    } catch (Exception e) {
                        Log.e(TAG, "Failed to start NodeRunner in worker thread", e);
                    }
                }
            }, "ZapNodeRunnerStarter").start();
        } catch (Exception e) {
            Log.e(TAG, "Error initiating NodeRunner startup", e);
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (notificationManager != null) {
                NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    CHANNEL_NAME,
                    NotificationManager.IMPORTANCE_LOW
                );
                channel.setDescription(CHANNEL_DESC);
                channel.setShowBadge(false);
                channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                notificationManager.createNotificationChannel(channel);
                Log.d(TAG, "NotificationChannel created: " + CHANNEL_ID);
            }
        }
    }

    private void startForegroundNotification() {
        Notification notification = buildOngoingNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            );
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        Log.d(TAG, "Service promoted to foreground with notification id: " + NOTIFICATION_ID);
    }

    @SuppressWarnings("deprecation")
    private Notification buildOngoingNotification() {
        int pendingIntentFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            pendingIntentFlags |= PendingIntent.FLAG_IMMUTABLE;
        }

        Intent stopIntent = new Intent(this, ZapForegroundService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPendingIntent = PendingIntent.getService(this, REQUEST_CODE_STOP, stopIntent, pendingIntentFlags);

        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent contentPendingIntent = null;
        if (launchIntent != null) {
            contentPendingIntent = PendingIntent.getActivity(this, REQUEST_CODE_MAIN, launchIntent, pendingIntentFlags);
        }

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }

        int iconRes = getApplicationInfo().icon != 0 ? getApplicationInfo().icon : android.R.drawable.stat_notify_sync;

        builder.setContentTitle(NOTIFICATION_TITLE)
            .setContentText(NOTIFICATION_TEXT)
            .setSmallIcon(iconRes)
            .setOngoing(true)
            .setAutoCancel(false);

        if (contentPendingIntent != null) {
            builder.setContentIntent(contentPendingIntent);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            builder.setCategory(Notification.CATEGORY_SERVICE);
            builder.setVisibility(Notification.VISIBILITY_PUBLIC);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder.setColor(COLOR_WHATSAPP_TEAL);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT_WATCH) {
            Notification.Action stopAction = new Notification.Action.Builder(
                android.R.drawable.ic_menu_close_clear_cancel,
                "Disconnect",
                stopPendingIntent
            ).build();
            builder.addAction(stopAction);
        }

        return builder.build();
    }

    private synchronized void initWakeLock() {
        if (wakeLock == null) {
            PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (powerManager != null) {
                wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG);
                wakeLock.setReferenceCounted(false);
                Log.d(TAG, "Partial WakeLock initialized.");
            }
        }
    }

    /**
     * Acquires and keeps Partial WakeLock active indefinitely.
     */
    private synchronized void acquireWakeLock() {
        acquireWakeLock(0);
    }

    /**
     * Acquires Partial WakeLock. If timeoutMs is 0 or negative, acquires indefinite lock.
     */
    private synchronized void acquireWakeLock(long timeoutMs) {
        try {
            initWakeLock();
            if (wakeLock != null && !wakeLock.isHeld()) {
                if (timeoutMs > 0) {
                    wakeLock.acquire(timeoutMs);
                    Log.d(TAG, "Acquired Partial WakeLock with timeout: " + timeoutMs + " ms");
                } else {
                    wakeLock.acquire();
                    Log.d(TAG, "Acquired Partial WakeLock (active indefinitely)");
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to acquire Partial WakeLock", e);
        }
    }

    private synchronized void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
                Log.d(TAG, "Released Partial WakeLock");
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to release Partial WakeLock", e);
        }
    }

    /**
     * Registers network callback to monitor connectivity changes.
     * When network connectivity is restored, ensures Partial WakeLock is active and NodeRunner is running.
     */
    private void registerNetworkCallback() {
        try {
            connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (connectivityManager == null) {
                Log.w(TAG, "ConnectivityManager not available.");
                return;
            }

            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    super.onAvailable(network);
                    isNetworkConnected = true;
                    Log.i(TAG, "Network available. Keeping Partial WakeLock active and ensuring NodeRunner.");
                    acquireWakeLock();
                    if (!NodeRunner.isRunning()) {
                        startNodeRunner();
                    }
                }

                @Override
                public void onLost(Network network) {
                    super.onLost(network);
                    isNetworkConnected = false;
                    Log.w(TAG, "Network lost. Waiting for connection recovery.");
                }

                @Override
                public void onCapabilitiesChanged(Network network, NetworkCapabilities networkCapabilities) {
                    super.onCapabilitiesChanged(network, networkCapabilities);
                    boolean hasInternet = networkCapabilities != null
                            && networkCapabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                            && networkCapabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
                    isNetworkConnected = hasInternet;
                    Log.d(TAG, "Network capabilities changed. Internet validated: " + hasInternet);
                }
            };

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                connectivityManager.registerDefaultNetworkCallback(networkCallback);
                Log.d(TAG, "Registered default network callback.");
            } else {
                NetworkRequest request = new NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build();
                connectivityManager.registerNetworkCallback(request, networkCallback);
                Log.d(TAG, "Registered network callback with NetworkRequest.");
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not register network callback", e);
        }
    }

    private void unregisterNetworkCallback() {
        if (networkCallback != null && connectivityManager != null) {
            try {
                connectivityManager.unregisterNetworkCallback(networkCallback);
                Log.d(TAG, "Unregistered network callback.");
            } catch (Exception e) {
                Log.w(TAG, "Error unregistering network callback", e);
            }
            networkCallback = null;
        }
    }

    @SuppressWarnings("deprecation")
    public static boolean isNetworkAvailable(Context context) {
        if (context == null) return false;
        try {
            ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Network active = cm.getActiveNetwork();
                if (active == null) return false;
                NetworkCapabilities caps = cm.getNetworkCapabilities(active);
                return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
            } else {
                android.net.NetworkInfo netInfo = cm.getActiveNetworkInfo();
                return netInfo != null && netInfo.isConnected();
            }
        } catch (Exception e) {
            Log.e(TAG, "Error checking network connectivity", e);
            return false;
        }
    }

    @SuppressWarnings("deprecation")
    private void stopServiceGracefully() {
        isRunning = false;
        releaseWakeLock();
        unregisterNetworkCallback();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        stopSelf();
        Log.i(TAG, "ZapForegroundService stopped successfully.");
    }

    public static void start(Context context) {
        if (context == null) return;
        Intent intent = new Intent(context, ZapForegroundService.class);
        intent.setAction(ACTION_START);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
            Log.i(TAG, "ZapForegroundService start intent dispatched.");
        } catch (Exception e) {
            Log.e(TAG, "Failed to start ZapForegroundService", e);
        }
    }

    public static void stop(Context context) {
        if (context == null) return;
        Intent intent = new Intent(context, ZapForegroundService.class);
        intent.setAction(ACTION_STOP);
        try {
            context.startService(intent);
            Log.i(TAG, "ZapForegroundService stop intent dispatched.");
        } catch (Exception e) {
            Log.e(TAG, "Failed to stop ZapForegroundService", e);
        }
    }
}
