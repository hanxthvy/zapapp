// [xihanzu-NR]
package com.janeasystems.nodejs_mobile;

import android.content.Context;
import android.os.Build;
import android.util.Log;

/**
 * NodeJsMobile - Janea Systems compatible wrapper around NodeRunner and libnode.
 */
public class NodeJsMobile {

    private static final String TAG = "NodeJsMobile";

    static {
        try {
            System.loadLibrary("node");
        } catch (UnsatisfiedLinkError e) {
            Log.e(TAG, "Failed to load 'node' library", e);
        }
    }

    /**
     * Returns the primary ABI name for the current Android device.
     */
    public static String getCurrentABIName() {
        if (Build.SUPPORTED_ABIS != null && Build.SUPPORTED_ABIS.length > 0) {
            return Build.SUPPORTED_ABIS[0];
        }
        return "arm64-v8a";
    }

    /**
     * Starts Node.js with the provided arguments array.
     */
    public static int startNodeWithArguments(String[] arguments) {
        return NodeRunner.startNodeWithArguments(arguments);
    }

    /**
     * Starts Node.js with arguments on a background thread using the application context.
     */
    public static void startNode(Context context) {
        NodeRunner.startNode(context);
    }

    /**
     * Starts Node.js with an entry script on a background thread.
     */
    public static void startNode(Context context, String entryScript) {
        NodeRunner.startNode(context, entryScript);
    }

    /**
     * Checks if the Node runtime is currently running.
     */
    public static boolean isRunning() {
        return NodeRunner.isRunning();
    }
}
