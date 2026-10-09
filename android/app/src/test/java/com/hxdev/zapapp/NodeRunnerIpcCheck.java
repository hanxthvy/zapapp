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
 * Runnable self-check verifying line-delimited TCP IPC protocol mechanics.
 */
public final class NodeRunnerIpcCheck {

    public static void main(String[] args) throws Exception {
        int testPort = 28995;
        try (ServerSocket server = new ServerSocket(testPort)) {
            Thread client = new Thread(() -> {
                try {
                    Socket s = new Socket("127.0.0.1", testPort);
                    BufferedWriter out = new BufferedWriter(new OutputStreamWriter(s.getOutputStream(), StandardCharsets.UTF_8));
                    BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));

                    // Send command
                    out.write("{\"command\":\"send_message\",\"args\":{\"to\":\"test@s.whatsapp.net\",\"text\":\"hello\"},\"reqId\":\"req_1\"}\n");
                    out.flush();

                    // Read response
                    String resp = in.readLine();
                    assert resp != null : "Response must not be null";
                    assert resp.contains("\"status\":\"ok\"") : "Response must be ok";
                    assert resp.contains("\"reqId\":\"req_1\"") : "reqId must match";

                    s.close();
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            client.start();

            try (Socket accepted = server.accept()) {
                BufferedReader sIn = new BufferedReader(new InputStreamReader(accepted.getInputStream(), StandardCharsets.UTF_8));
                BufferedWriter sOut = new BufferedWriter(new OutputStreamWriter(accepted.getOutputStream(), StandardCharsets.UTF_8));

                String request = sIn.readLine();
                assert request != null : "Request must not be null";
                assert request.contains("send_message") : "Command must be send_message";

                sOut.write("{\"reqId\":\"req_1\",\"status\":\"ok\",\"result\":{\"id\":\"MSG_123\"}}\n");
                sOut.flush();
            }

            client.join(3000);
        }
        System.out.println("NodeRunner IPC self-check passed successfully.");
    }
}
