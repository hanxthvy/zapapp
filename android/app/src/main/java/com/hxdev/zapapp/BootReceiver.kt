// [xihanzu-NR]
package com.hxdev.zapapp

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * BroadcastReceiver responsible for auto-starting ZapForegroundService
 * when the Android device completes booting or updates the app package.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        if (intent == null) return

        val action = intent.action
        Log.d(TAG, "Received broadcast intent action: $action")

        val isBootAction = when (action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            ACTION_QUICKBOOT_POWERON,
            ACTION_HTC_QUICKBOOT_POWERON,
            Intent.ACTION_REBOOT,
            ACTION_POWER_CONNECTED -> true
            else -> false
        }

        if (isBootAction) {
            Log.i(TAG, "Device boot completed or package updated. Launching ZapForegroundService...")
            try {
                ZapForegroundService.start(context)
                Log.i(TAG, "ZapForegroundService successfully triggered from BootReceiver.")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start ZapForegroundService on boot", e)
            }
        }
    }

    companion object {
        private const val TAG = "ZapBootReceiver"
        private const val ACTION_QUICKBOOT_POWERON = "android.intent.action.QUICKBOOT_POWERON"
        private const val ACTION_HTC_QUICKBOOT_POWERON = "com.htc.intent.action.QUICKBOOT_POWERON"
        private const val ACTION_POWER_CONNECTED = "android.intent.action.ACTION_POWER_CONNECTED"
    }
}
