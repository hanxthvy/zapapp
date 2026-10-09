// [xihanzu-NR]
package com.hxdev.zapapp;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.system.Os;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * NodeRunner - Manages background execution of embedded Node.js (libnode.so)
 * loading /android_asset/nodejs-project/main.js and coordinates IPC channels.
 */
public final class NodeRunner {
    private static final String TAG = "NodeRunner";
    public static final String NODE_PROJECT_DIR = "nodejs-project";
    public static final String DEFAULT_ENTRY_SCRIPT = "main.js";
    public static final int DEFAULT_IPC_PORT = 28789;

    private static final String SHARED_PREFS = "NODE_RUNNER_PREFS";
    private static final String KEY_LAST_UPDATE = "apk_last_update_time";

    private static volatile boolean nodeRunning = false;
    private static Thread nodeThread = null;
    private static IpcClient ipcClient = null;

    // ponytail: Local TCP loopback socket used for IPC; upgrade to Unix Domain LocalSocket if inter-process isolation strictly required.

    static {
        try {
            System.loadLibrary("node");
            System.loadLibrary("node_bridge");
            Log.i(TAG, "Native library 'node' loaded successfully.");
        } catch (UnsatisfiedLinkError e) {
            Log.w(TAG, "Native library 'node' not loaded: " + e.getMessage());
        }
        try {
            System.loadLibrary("zapapp_core");
            Log.i(TAG, "Native library 'zapapp_core' linked with NodeRunner.");
        } catch (UnsatisfiedLinkError e) {
            Log.d(TAG, "Native library 'zapapp_core' not loaded in NodeRunner: " + e.getMessage());
        }
    }

    // Native JNI methods for libnode and core bridge
    public static native int startNodeWithArguments(String[] arguments);
    public static native void sendNodeMessage(String message);
    public static native String getNodeMessage();

    public interface IpcCallback {
        void onResponse(boolean success, JSONObject response);
    }

    public interface EventListener {
        void onEvent(String event, JSONObject data);
    }

    private static final List<EventListener> eventListeners = new CopyOnWriteArrayList<>();

    private NodeRunner() {}

    public static void addEventListener(EventListener listener) {
        if (listener != null) {
            eventListeners.add(listener);
        }
    }

    public static void removeEventListener(EventListener listener) {
        if (listener != null) {
            eventListeners.remove(listener);
        }
    }

    /**
     * Dispatches an inbound event to every registered listener, then forwards
     * it to the NativeZapCore callbacks. Package-private so the wiring self-check
     * can exercise the registry without a live IPC socket.
     */
    static void dispatchInboundEvent(String event, JSONObject data) {
        for (EventListener listener : eventListeners) {
            try {
                listener.onEvent(event, data);
            } catch (Exception e) {
                Log.e(TAG, "Error in NodeRunner event listener", e);
            }
        }

        // Forward to NativeZapCore callbacks if present
        try {
            if ("auth_qr".equals(event) || "qr_live".equals(event)) {
                String qr = data.optString("qr", data.optString("payload", ""));
                if (!qr.isEmpty()) NativeZapCore.dispatchQr(qr);
            } else if ("auth_pairing_code".equals(event) || "pairing_code_live".equals(event)) {
                String code = data.optString("formattedCode", data.optString("code", ""));
                NativeZapCore.dispatchPairingState("pairing_code", code);
            } else if ("auth_paired".equals(event)) {
                String jid = data.optString("jid", data.optString("meJid", ""));
                NativeZapCore.dispatchPairingState("paired", jid);
            } else if ("message".equals(event)) {
                String chatId = data.optString("chatId", "");
                String id = data.optString("id", "");
                String text = data.optString("text", data.optString("content", ""));
                String type = data.optString("type", "text");
                long ts = data.optLong("timestamp", System.currentTimeMillis());
                NativeZapCore.dispatchMessage(chatId, id, text, type, ts);
            } else if ("connection".equals(event)) {
                String status = data.optString("status", "");
                NativeZapCore.dispatchPairingState(status, data.toString());
            }
        } catch (Throwable ignored) {}
    }

    public static boolean isRunning() {
        return nodeRunning;
    }

    public static String getProjectDir(Context context) {
        return context.getApplicationContext().getFilesDir().getAbsolutePath() + "/" + NODE_PROJECT_DIR;
    }

    /**
     * Starts Node.js with default entry point (main.js) and standard IPC port.
     */
    public static synchronized void start(Context context) {
        start(context, DEFAULT_ENTRY_SCRIPT, DEFAULT_IPC_PORT);
    }

    public static synchronized void startNode(Context context) {
        start(context);
    }

    public static synchronized void startNode(Context context, String entryScript) {
        start(context, entryScript, DEFAULT_IPC_PORT);
    }

    /**
     * Starts Node.js with specific entry script and IPC port.
     */
    public static synchronized void start(final Context context, final String entryScript, final int ipcPort) {
        if (nodeRunning) {
            Log.w(TAG, "Node.js runtime already active.");
            return;
        }

        final Context appContext = context.getApplicationContext();
        final String filesDirPath = appContext.getFilesDir().getAbsolutePath();
        final String projectPath = filesDirPath + "/" + NODE_PROJECT_DIR;
        final String scriptPath = projectPath + "/" + entryScript;

        try {
            prepareAssets(appContext);
        } catch (IOException e) {
            Log.e(TAG, "Failed to extract nodejs-project assets: " + e.getMessage(), e);
            return;
        }

        setupEnvironment(appContext, projectPath, ipcPort);

        nodeRunning = true;
        nodeThread = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    List<String> argsList = new ArrayList<>();
                    argsList.add("node");
                    argsList.add(scriptPath);
                    String[] args = argsList.toArray(new String[0]);

                    Log.i(TAG, "Starting Node.js engine with: " + Arrays.toString(args));
                    int exitCode = 0;
                    try {
                        exitCode = startNodeWithArguments(args);
                    } catch (UnsatisfiedLinkError ule) {
                        Log.w(TAG, "Local startNodeWithArguments symbol unbound, trying fallback: " + ule.getMessage());
                        try {
                            exitCode = com.janeasystems.nodejs_mobile.NodeRunner.startNodeWithArguments(args);
                        } catch (Throwable t) {
                            Log.e(TAG, "NodeRunner fallback failed: " + t.getMessage(), t);
                        }
                    }
                    Log.i(TAG, "Node.js engine exited with status: " + exitCode);
                } catch (Exception e) {
                    Log.e(TAG, "Exception in Node.js background thread", e);
                } finally {
                    nodeRunning = false;
                    if (ipcClient != null) {
                        ipcClient.stop();
                        ipcClient = null;
                    }
                }
            }
        }, "zap-node-runner");

        nodeThread.setDaemon(true);
        nodeThread.start();

        // Connect IPC bridge client to Node.js localhost TCP server
        if (ipcClient == null) {
            ipcClient = new IpcClient("127.0.0.1", ipcPort);
            ipcClient.start();
        }
    }

    /**
     * Stops the Node IPC bridge and notifies runtime.
     */
    public static synchronized void stop() {
        if (ipcClient != null) {
            ipcClient.stop();
            ipcClient = null;
        }
        nodeRunning = false;
        if (nodeThread != null && nodeThread.isAlive()) {
            nodeThread.interrupt();
            nodeThread = null;
        }
        Log.i(TAG, "NodeRunner stopped.");
    }

    // -------------------------------------------------------------------------
    // IPC High-Level Command API
    // -------------------------------------------------------------------------

    public static void sendMessage(String to, String text, IpcCallback callback) {
        try {
            JSONObject args = new JSONObject();
            args.put("to", to);
            args.put("text", text);
            sendCommand("send_message", args, callback);
        } catch (JSONException e) {
            if (callback != null) callback.onResponse(false, null);
        }
    }

    public static void sendButtonMessage(String to, String text, String buttonsJson, IpcCallback callback) {
        try {
            JSONObject args = new JSONObject();
            args.put("to", to);
            args.put("text", text);
            args.put("buttons", new JSONArray(buttonsJson != null ? buttonsJson : "[]"));
            sendCommand("send_button_message", args, callback);
        } catch (Exception e) {
            if (callback != null) callback.onResponse(false, null);
        }
    }

    public static void requestPairingCode(String phoneNumber, IpcCallback callback) {
        try {
            JSONObject args = new JSONObject();
            args.put("phoneNumber", phoneNumber);
            sendCommand("request_pairing_code", args, callback);
        } catch (JSONException e) {
            if (callback != null) callback.onResponse(false, null);
        }
    }

    public static void disconnectWa(IpcCallback callback) {
        sendCommand("disconnect", new JSONObject(), callback);
    }

    public static void sendCommand(String command, JSONObject args, IpcCallback callback) {
        if (ipcClient == null) {
            Log.w(TAG, "IPC client inactive, cannot send command: " + command);
            if (callback != null) callback.onResponse(false, null);
            return;
        }
        ipcClient.sendCommand(command, args, callback);
    }

    public static void sendRawIpc(String jsonMessage) {
        if (ipcClient != null) {
            ipcClient.sendRaw(jsonMessage);
        } else {
            try {
                sendNodeMessage(jsonMessage);
            } catch (UnsatisfiedLinkError e) {
                Log.w(TAG, "sendNodeMessage JNI fallback unbound: " + e.getMessage());
            }
        }
    }

    // -------------------------------------------------------------------------
    // Asset Management & Environment Setup
    // -------------------------------------------------------------------------

    public static synchronized void prepareAssets(Context context) throws IOException {
        String filesDirPath = context.getFilesDir().getAbsolutePath();
        String targetDirPath = filesDirPath + "/" + NODE_PROJECT_DIR;
        File targetDir = new File(targetDirPath);

        if (wasApkUpdated(context) || !targetDir.exists()) {
            Log.i(TAG, "Unpacking nodejs-project assets to: " + targetDirPath);
            if (targetDir.exists()) {
                deleteRecursively(targetDir);
            }
            copyAssetFolder(context.getAssets(), NODE_PROJECT_DIR, targetDirPath);
            saveLastUpdateTime(context);
            Log.i(TAG, "Asset unpacking completed.");
        }
    }

    private static void setupEnvironment(Context context, String projectPath, int ipcPort) {
        try {
            String cacheDir = context.getCacheDir().getAbsolutePath();
            String filesDir = context.getFilesDir().getAbsolutePath();

            Os.setenv("TMPDIR", cacheDir, true);
            Os.setenv("HOME", projectPath, true);
            Os.setenv("NODEJS_STORAGE_PATH", filesDir, true);
            Os.setenv("NODEJS_IPC_PORT", String.valueOf(ipcPort), true);
            Log.d(TAG, "Node environment set: HOME=" + projectPath + ", PORT=" + ipcPort);
        } catch (Exception e) {
            Log.w(TAG, "Could not set Os environment variables: " + e.getMessage());
        }
    }

    private static boolean wasApkUpdated(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(SHARED_PREFS, Context.MODE_PRIVATE);
        long prevTime = prefs.getLong(KEY_LAST_UPDATE, 0);
        long curTime = 1;
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            curTime = info.lastUpdateTime;
        } catch (PackageManager.NameNotFoundException ignored) {}
        return prevTime != curTime;
    }

    private static void saveLastUpdateTime(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            SharedPreferences.Editor ed = context.getSharedPreferences(SHARED_PREFS, Context.MODE_PRIVATE).edit();
            ed.putLong(KEY_LAST_UPDATE, info.lastUpdateTime);
            ed.apply();
        } catch (PackageManager.NameNotFoundException ignored) {}
    }

    private static void copyAssetFolder(AssetManager assets, String src, String dst) throws IOException {
        String[] files = assets.list(src);
        if (files == null || files.length == 0) {
            copyAssetFile(assets, src, dst);
        } else {
            File d = new File(dst);
            if (!d.exists()) d.mkdirs();
            for (String f : files) {
                String sSub = src.isEmpty() ? f : src + "/" + f;
                String dSub = dst + "/" + f;
                copyAssetFolder(assets, sSub, dSub);
            }
        }
    }

    private static void copyAssetFile(AssetManager assets, String src, String dst) throws IOException {
        File outFile = new File(dst);
        File parent = outFile.getParentFile();
        if (parent != null && !parent.exists()) parent.mkdirs();

        try (InputStream in = assets.open(src);
             OutputStream out = new FileOutputStream(outFile)) {
            byte[] buf = new byte[8192];
            int r;
            while ((r = in.read(buf)) != -1) {
                out.write(buf, 0, r);
            }
            out.flush();
        }
    }

    private static void deleteRecursively(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File c : children) deleteRecursively(c);
            }
        }
        file.delete();
    }

    // -------------------------------------------------------------------------
    // IPC Socket Bridge Client
    // -------------------------------------------------------------------------

    private static class IpcClient {
        private final String host;
        private final int port;
        private final AtomicBoolean running = new AtomicBoolean(false);
        private final AtomicLong reqCounter = new AtomicLong(1);
        private final Map<String, IpcCallback> pendingCallbacks = new ConcurrentHashMap<>();
        private final ExecutorService sendExecutor = Executors.newSingleThreadExecutor();

        private Socket socket;
        private BufferedWriter writer;
        private Thread readerThread;

        IpcClient(String host, int port) {
            this.host = host;
            this.port = port;
        }

        void start() {
            running.set(true);
            readerThread = new Thread(new Runnable() {
                @Override
                public void run() {
                    connectAndListen();
                }
            }, "zap-node-ipc-reader");
            readerThread.setDaemon(true);
            readerThread.start();
        }

        void stop() {
            running.set(false);
            sendExecutor.shutdownNow();
            closeSocket();
            if (readerThread != null) {
                readerThread.interrupt();
            }
        }

        void sendCommand(String command, JSONObject args, final IpcCallback callback) {
            final String reqId = "req_" + reqCounter.getAndIncrement();
            if (callback != null) {
                pendingCallbacks.put(reqId, callback);
            }

            try {
                JSONObject payload = new JSONObject();
                payload.put("command", command);
                payload.put("args", args != null ? args : new JSONObject());
                payload.put("reqId", reqId);

                sendRaw(payload.toString());
            } catch (JSONException e) {
                if (callback != null) {
                    pendingCallbacks.remove(reqId);
                    callback.onResponse(false, null);
                }
            }
        }

        void sendRaw(final String message) {
            sendExecutor.execute(new Runnable() {
                @Override
                public void run() {
                    try {
                        synchronized (IpcClient.this) {
                            if (writer != null) {
                                writer.write(message);
                                writer.write("\n");
                                writer.flush();
                            }
                        }
                    } catch (IOException e) {
                        Log.w(TAG, "IPC socket write failed: " + e.getMessage());
                    }
                }
            });
        }

        private void connectAndListen() {
            int retries = 0;
            while (running.get()) {
                try {
                    Log.d(TAG, "Attempting IPC connection to " + host + ":" + port);
                    Socket s = new Socket();
                    s.connect(new InetSocketAddress(host, port), 2000);

                    synchronized (this) {
                        this.socket = s;
                        this.writer = new BufferedWriter(new OutputStreamWriter(s.getOutputStream(), StandardCharsets.UTF_8));
                    }
                    Log.i(TAG, "Connected to Node.js IPC socket on " + host + ":" + port);
                    retries = 0;

                    BufferedReader reader = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
                    String line;
                    while (running.get() && (line = reader.readLine()) != null) {
                        handleIncomingLine(line.trim());
                    }
                } catch (Exception e) {
                    if (!running.get()) break;
                    retries++;
                    long backoff = Math.min(2000, 200 * retries);
                    Log.d(TAG, "IPC socket connection retry in " + backoff + "ms (" + e.getMessage() + ")");
                    try {
                        Thread.sleep(backoff);
                    } catch (InterruptedException ie) {
                        break;
                    }
                } finally {
                    closeSocket();
                }
            }
        }

        private void handleIncomingLine(String line) {
            if (line.isEmpty() || !line.startsWith("{")) return;
            try {
                JSONObject msg = new JSONObject(line);

                // 1. Response to outbound command
                if (msg.has("reqId")) {
                    String reqId = msg.optString("reqId");
                    IpcCallback cb = pendingCallbacks.remove(reqId);
                    if (cb != null) {
                        boolean ok = "ok".equalsIgnoreCase(msg.optString("status"));
                        cb.onResponse(ok, msg);
                    }
                }

                // 2. Inbound event pushed by Node
                if (msg.has("event")) {
                    String event = msg.optString("event");
                    JSONObject data = msg.optJSONObject("data");
                    dispatchInboundEvent(event, data != null ? data : msg);
                }
            } catch (Exception e) {
                Log.w(TAG, "Error parsing incoming IPC JSON: " + e.getMessage());
            }
        }

        private synchronized void closeSocket() {
            try {
                if (writer != null) {
                    writer.close();
                    writer = null;
                }
            } catch (Exception ignored) {}
            try {
                if (socket != null && !socket.isClosed()) {
                    socket.close();
                    socket = null;
                }
            } catch (Exception ignored) {}
        }
    }
}
