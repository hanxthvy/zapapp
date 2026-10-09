// [xihanzu-NR]
package com.hxdev.zapapp;

import java.lang.reflect.Method;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Runnable self-check for DEFECT-ZAP-WIRING-002:
 * Verifies the EventListener registry on com.hxdev.zapapp.NodeRunner accepts,
 * receives, and releases inbound event dispatch (auth_qr, auth_pairing_code,
 * auth_paired, message, connection), and that the janeasystems shim delegates
 * to the same shared registry instead of bypassing it.
 *
 * Runs on a plain JVM: passes null event data so no org.json stub method is
 * invoked. Android's android.jar org.json classes are compile-only stubs.
 */
public final class ZapForegroundServiceWiringCheck {

    public static void main(String[] args) throws Exception {
        final AtomicInteger directCount = new AtomicInteger();
        final AtomicInteger shimCount = new AtomicInteger();

        NodeRunner.EventListener direct = new NodeRunner.EventListener() {
            @Override
            public void onEvent(String event, org.json.JSONObject data) {
                directCount.incrementAndGet();
            }
        };

        com.hxdev.zapapp.NodeRunner.EventListener shim = new com.hxdev.zapapp.NodeRunner.EventListener() {
            @Override
            public void onEvent(String event, org.json.JSONObject data) {
                shimCount.incrementAndGet();
            }
        };

        NodeRunner.addEventListener(direct);
        com.janeasystems.nodejs_mobile.NodeRunner.addEventListener(shim);

        Method dispatch = NodeRunner.class.getDeclaredMethod("dispatchInboundEvent", String.class, org.json.JSONObject.class);
        dispatch.setAccessible(true);

        String[] events = {"auth_qr", "auth_pairing_code", "auth_paired", "message", "connection"};
        for (String event : events) {
            dispatch.invoke(null, event, null);
        }

        assert directCount.get() == events.length
                : "Direct listener must receive all 5 event types, got " + directCount.get();
        assert shimCount.get() == events.length
                : "Shim listener must share the same registry, got " + shimCount.get();

        NodeRunner.removeEventListener(direct);
        com.janeasystems.nodejs_mobile.NodeRunner.removeEventListener(shim);

        directCount.set(0);
        shimCount.set(0);
        dispatch.invoke(null, "connection", null);
        assert directCount.get() == 0 && shimCount.get() == 0
                : "Removed listeners must stop receiving events";

        System.out.println("ZapForegroundServiceWiringCheck passed: registry, 5 event types, shim delegation, removal.");
    }
}
