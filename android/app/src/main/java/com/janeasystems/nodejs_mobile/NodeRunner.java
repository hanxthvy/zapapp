// [xihanzu-NR]
package com.janeasystems.nodejs_mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.system.Os;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * NodeRunner - Java helper and bridge to the embedded Node.js Mobile runtime.
 * Manages extraction of nodejs-project assets, runtime configuration,
 * and lifecycle execution of node::Start on a dedicated thread.
 */
public class NodeRunner {

    private static final String TAG = "NodeRunner";
    public static final String NODE_PROJECT_DIR = "nodejs-project";
    private static final String SHARED_PREFS = "NODEJS_MOBILE_PREFS";
    private static final String LAST_UPDATED_TIME = "NODEJS_MOBILE_APK_LastUpdateTime";

    private static volatile boolean nodeRunning = false;
    private static Thread nodeThread = null;

    static {
        try {
            System.loadLibrary("node");
            Log.i(TAG, "Native library 'node' loaded successfully.");
        } catch (UnsatisfiedLinkError e) {
            Log.e(TAG, "Failed to load native library 'node'", e);
        }
        try {
            System.loadLibrary("zapapp_core");
            Log.i(TAG, "Native library 'zapapp_core' linked with NodeRunner.");
        } catch (UnsatisfiedLinkError e) {
            Log.d(TAG, "Library 'zapapp_core' not loaded in NodeRunner static block: " + e.getMessage());
        }
    }

    /**
     * Native JNI method to invoke node::Start with given arguments.
     * Implemented by native bridge layer.
     */
    public static native int startNodeWithArguments(String[] arguments);

    /**
     * Starts Node.js with the default project entry point (main.js).
     */
    public static synchronized void startNode(Context context) {
        startNode(context, "main.js");
    }

    /**
     * Starts Node.js with a specific script file inside the nodejs-project directory.
     */
    public static synchronized void startNode(Context context, String entryScript) {
        if (nodeRunning) {
            Log.w(TAG, "Node.js engine is already running in this process.");
            return;
        }

        final Context appContext = context.getApplicationContext();
        final String filesDirPath = appContext.getFilesDir().getAbsolutePath();
        final String projectPath = filesDirPath + "/" + NODE_PROJECT_DIR;
        final String scriptPath = projectPath + "/" + entryScript;

        // Ensure assets are extracted and up-to-date
        try {
            prepareNodeProjectAssets(appContext);
        } catch (IOException e) {
            Log.e(TAG, "Failed to unpack nodejs-project assets: " + e.getMessage(), e);
            return;
        }

        // Configure system environment variables for Node runtime
        setupEnvironment(appContext, projectPath);

        List<String> argsList = new ArrayList<>();
        argsList.add("node");
        argsList.add(scriptPath);

        startNodeWithArguments(appContext, argsList.toArray(new String[0]));
    }

    /**
     * Starts Node.js on a dedicated background thread with custom arguments.
     */
    public static synchronized void startNodeWithArguments(final Context context, final String[] arguments) {
        if (nodeRunning) {
            Log.w(TAG, "Node.js is already running.");
            return;
        }

        nodeRunning = true;
        nodeThread = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    Log.i(TAG, "Starting Node.js engine with args: " + Arrays.toString(arguments));
                    int exitCode = startNodeWithArguments(arguments);
                    Log.i(TAG, "Node.js engine exited with code: " + exitCode);
                } catch (UnsatisfiedLinkError ule) {
                    Log.e(TAG, "startNodeWithArguments native symbol not bound: " + ule.getMessage(), ule);
                } catch (Exception e) {
                    Log.e(TAG, "Exception running Node.js runtime: " + e.getMessage(), e);
                } finally {
                    nodeRunning = false;
                }
            }
        }, "nodejs-runtime-thread");

        nodeThread.setDaemon(true);
        nodeThread.start();
    }

    /**
     * Checks if the Node.js runtime thread is currently active.
     */
    public static boolean isRunning() {
        return nodeRunning;
    }

    /**
     * Returns the absolute path where the nodejs-project is stored in app internal storage.
     */
    public static String getNodeProjectPath(Context context) {
        return context.getApplicationContext().getFilesDir().getAbsolutePath() + "/" + NODE_PROJECT_DIR;
    }

    /**
     * Prepares nodejs-project directory by copying assets when APK has been updated or installed.
     */
    public static synchronized void prepareNodeProjectAssets(Context context) throws IOException {
        String filesDirPath = context.getFilesDir().getAbsolutePath();
        String targetDirPath = filesDirPath + "/" + NODE_PROJECT_DIR;
        File targetDir = new File(targetDirPath);

        if (wasAPKUpdated(context) || !targetDir.exists()) {
            Log.i(TAG, "Unpacking or updating nodejs-project assets to: " + targetDirPath);
            if (targetDir.exists()) {
                deleteRecursively(targetDir);
            }
            copyAssetFolder(context.getAssets(), NODE_PROJECT_DIR, targetDirPath);
            saveLastUpdateTime(context);
            Log.i(TAG, "nodejs-project assets unpacked successfully.");
        }
    }

    /**
     * Configures TMPDIR and HOME environment variables for libuv and Node.js.
     */
    private static void setupEnvironment(Context context, String projectPath) {
        try {
            String cacheDir = context.getCacheDir().getAbsolutePath();
            Os.setenv("TMPDIR", cacheDir, true);
            Os.setenv("HOME", projectPath, true);
            Log.d(TAG, "Environment configured. TMPDIR=" + cacheDir + ", HOME=" + projectPath);
        } catch (Exception e) {
            Log.w(TAG, "Could not set environment variables: " + e.getMessage());
        }
    }

    /**
     * Checks if the APK has been updated since the last assets extraction.
     */
    private static boolean wasAPKUpdated(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(SHARED_PREFS, Context.MODE_PRIVATE);
        long previousLastUpdateTime = prefs.getLong(LAST_UPDATED_TIME, 0);
        long lastUpdateTime = 1;
        try {
            PackageInfo packageInfo = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            lastUpdateTime = packageInfo.lastUpdateTime;
        } catch (PackageManager.NameNotFoundException e) {
            Log.e(TAG, "Package name not found", e);
        }
        return (lastUpdateTime != previousLastUpdateTime);
    }

    /**
     * Saves the current APK lastUpdateTime to SharedPreferences.
     */
    private static void saveLastUpdateTime(Context context) {
        long lastUpdateTime = 1;
        try {
            PackageInfo packageInfo = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            lastUpdateTime = packageInfo.lastUpdateTime;
        } catch (PackageManager.NameNotFoundException e) {
            Log.e(TAG, "Package name not found", e);
        }
        SharedPreferences prefs = context.getSharedPreferences(SHARED_PREFS, Context.MODE_PRIVATE);
        SharedPreferences.Editor editor = prefs.edit();
        editor.putLong(LAST_UPDATED_TIME, lastUpdateTime);
        editor.apply();
    }

    /**
     * Recursively copies an asset folder from APK assets to destination path.
     */
    private static void copyAssetFolder(AssetManager assetManager, String srcPath, String destPath) throws IOException {
        String[] assets = assetManager.list(srcPath);
        if (assets == null || assets.length == 0) {
            copyAssetFile(assetManager, srcPath, destPath);
        } else {
            File dir = new File(destPath);
            if (!dir.exists()) {
                dir.mkdirs();
            }
            for (String asset : assets) {
                String subSrc = srcPath.isEmpty() ? asset : srcPath + "/" + asset;
                String subDest = destPath + "/" + asset;
                copyAssetFolder(assetManager, subSrc, subDest);
            }
        }
    }

    /**
     * Copies a single asset file to destination path.
     */
    private static void copyAssetFile(AssetManager assetManager, String srcPath, String destPath) throws IOException {
        File outFile = new File(destPath);
        File parent = outFile.getParentFile();
        if (parent != null && !parent.exists()) {
            parent.mkdirs();
        }
        try (InputStream in = assetManager.open(srcPath);
             OutputStream out = new FileOutputStream(outFile)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            out.flush();
        }
    }

    /**
     * Recursively deletes a file or directory.
     */
    private static void deleteRecursively(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        file.delete();
    }
}
