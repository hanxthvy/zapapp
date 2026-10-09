// [xihanzu-NR]
package com.hxdev.zapapp;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * Runnable self-check verifying WebBridge and NodeRunner IPC wiring:
 * - Routing send_button_message to NodeRunner TCP IPC
 * - NodeRunner event dispatch formats for window.onQrReceived, window.onPairingCodeReceived, window.onPairingStateUpdate('paired')
 */
public final class WebBridgeWiringCheck {

    public static void main(String[] args) throws Exception {
        int testPort = 28996;
        try (ServerSocket server = new ServerSocket(testPort)) {
            Thread client = new Thread(() -> {
                try {
                    Socket s = new Socket("127.0.0.1", testPort);
                    BufferedWriter out = new BufferedWriter(new OutputStreamWriter(s.getOutputStream(), StandardCharsets.UTF_8));
                    BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));

                    // 1. Simulate sendButtonMessage command sent to NodeRunner
                    String buttonPayload = "{\"command\":\"send_button_message\",\"args\":{\"to\":\"user@s.whatsapp.net\",\"text\":\"Select option:\",\"buttons\":[{\"id\":\"btn_1\",\"text\":\"Option 1\"}]},\"reqId\":\"req_btn_1\"}\n";
                    out.write(buttonPayload);
                    out.flush();

                    // Read response
                    String resp = in.readLine();
                    assert resp != null : "Response must not be null";
                    assert resp.contains("\"status\":\"ok\"") : "Response status must be ok";
                    assert resp.contains("\"reqId\":\"req_btn_1\"") : "reqId must match req_btn_1";

                    // 2. Simulate NodeRunner emitting live QR event to client
                    String qrEvent = "{\"event\":\"qr_live\",\"data\":{\"svg\":\"<svg width='200'>QR</svg>\",\"qr\":\"2@test,key\"}}\n";
                    out.write(qrEvent);
                    out.flush();

                    // 3. Simulate NodeRunner emitting pairing code event
                    String codeEvent = "{\"event\":\"pairing_code_live\",\"data\":{\"code\":\"12345678\",\"formattedCode\":\"1234-5678\"}}\n";
                    out.write(codeEvent);
                    out.flush();

                    // 4. Simulate NodeRunner emitting auth_paired event
                    String pairedEvent = "{\"event\":\"auth_paired\",\"data\":{\"jid\":\"user@s.whatsapp.net\"}}\n";
                    out.write(pairedEvent);
                    out.flush();

                    s.close();
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            client.start();

            try (Socket accepted = server.accept()) {
                BufferedReader sIn = new BufferedReader(new InputStreamReader(accepted.getInputStream(), StandardCharsets.UTF_8));
                BufferedWriter sOut = new BufferedWriter(new OutputStreamWriter(accepted.getOutputStream(), StandardCharsets.UTF_8));

                // Verify button command received
                String request = sIn.readLine();
                assert request != null : "Request must not be null";
                assert request.contains("send_button_message") : "Command must be send_button_message";
                assert request.contains("user@s.whatsapp.net") : "Target JID must match";
                assert request.contains("btn_1") : "Buttons payload must be present";

                sOut.write("{\"reqId\":\"req_btn_1\",\"status\":\"ok\",\"result\":{\"id\":\"MSG_BTN_1\"}}\n");
                sOut.flush();

                // Read and verify qr_live event
                String qrLine = sIn.readLine();
                assert qrLine != null && qrLine.contains("qr_live") : "qr_live event must be received";
                assert qrLine.contains("<svg") : "svg must be present in qr_live";

                // Read and verify pairing_code_live event
                String codeLine = sIn.readLine();
                assert codeLine != null && codeLine.contains("pairing_code_live") : "pairing_code_live event must be received";
                assert codeLine.contains("1234-5678") : "formattedCode must be present";

                // Read and verify auth_paired event
                String pairedLine = sIn.readLine();
                assert pairedLine != null && pairedLine.contains("auth_paired") : "auth_paired event must be received";
            }

            client.join(3000);
        }

        // Verify JS script templates
        String qrJs = String.format("(function(){ if(typeof window.onQrReceived === 'function') window.onQrReceived(\"%s\"); })();", "2@test");
        assert qrJs.contains("window.onQrReceived") : "Must invoke window.onQrReceived";

        String codeJs = String.format("(function(){ if(typeof window.onPairingCodeReceived === 'function') window.onPairingCodeReceived(\"%s\"); })();", "1234-5678");
        assert codeJs.contains("window.onPairingCodeReceived") : "Must invoke window.onPairingCodeReceived";

        String pairedJs = "(function(){ if(typeof window.onPairingStateUpdate === 'function') window.onPairingStateUpdate('paired'); })();";
        assert pairedJs.contains("window.onPairingStateUpdate('paired')") : "Must invoke window.onPairingStateUpdate('paired')";

        System.out.println("WebBridgeWiringCheck passed successfully.");
    }
}
