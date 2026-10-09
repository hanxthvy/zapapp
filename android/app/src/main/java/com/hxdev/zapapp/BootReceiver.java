// [xihanzu-NR]
package com.hxdev.zapapp;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * Boot and power connectivity receiver to restart ZapForegroundService
 * and maintain background WhatsApp connection resiliency.
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "ZapBootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;

        String action = intent.getAction();
        Log.i(TAG, "BootReceiver received action: " + action);

        if (Intent.ACTION_BOOT_COMPLETED.equals(action) ||
            "android.intent.action.QUICKBOOT_POWERON".equals(action) ||
            Intent.ACTION_MY_PACKAGE_REPLACED.equals(action) ||
            Intent.ACTION_POWER_CONNECTED.equals(action)) {

            ZapForegroundService.start(context);
        }
    }
}
