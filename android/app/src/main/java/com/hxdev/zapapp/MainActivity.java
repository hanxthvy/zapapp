// [xihanzu-NR]
package com.hxdev.zapapp;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.io.File;

/**
 * Main Activity hosting the ZapApp lightweight Single Page Application inside Android WebView.
 * Handles:
 * - Edge-to-edge layout and status bar chrome styling
 * - Optimized WebView container configuration (DOM storage, JS bridge, hardware acceleration)
 * - Loading local bundled assets from ui/index.html
 * - Inbound and outbound JavaScriptInterface bridges (window.ZapNative, window.ZapBridge, window.Android)
 * - Coordinating NodeRunner embedded runtime and dispatching live QR, pairing code, and status events directly into WebView
 */
public class MainActivity extends Activity {
    private static final String TAG = "ZapMainActivity";

    public static final String BRIDGE_NAME_NATIVE = "ZapNative";
    public static final String BRIDGE_NAME_BRIDGE = "ZapBridge";
    public static final String BRIDGE_NAME_ANDROID = "Android";

    public static final String ASSET_URL = "file:///android_asset/ui/index.html";
    private static final int COLOR_APP_BACKGROUND = 0xFF111B21; // WhatsApp dark theme

    private WebView webView;
    private WebBridge webBridge;
    private NodeRunner.EventListener nodeEventListener;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Log.i(TAG, "MainActivity onCreate: Initializing ZapApp host.");

        configureWindowChrome();

        // Initialize Native Rust Core store & paths
        File dbFile = new File(getFilesDir(), "zapapp.db");
        NativeZapCore.init(dbFile.getAbsolutePath());

        // Ensure background persistent service is active
        ZapForegroundService.start(this);

        // Start embedded NodeRunner runtime for background WhatsApp engine & IPC
        NodeRunner.start(this);

        // Setup WebView host
        FrameLayout rootLayout = new FrameLayout(this);
        rootLayout.setLayoutParams(new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        rootLayout.setBackgroundColor(COLOR_APP_BACKGROUND);

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        webView.setBackgroundColor(COLOR_APP_BACKGROUND);

        rootLayout.addView(webView);
        setContentView(rootLayout);

        setupWebViewSettings();
        setupJavaScriptBridge();
        setupNodeRunnerWiring();
        loadLocalUiAssets();
    }

    private void configureWindowChrome() {
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        Window win = getWindow();
        if (win != null) {
            win.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
            win.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                win.setStatusBarColor(COLOR_APP_BACKGROUND);
                win.setNavigationBarColor(COLOR_APP_BACKGROUND);
            }
        }
    }

    private void setupWebViewSettings() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);

        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);

        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setDefaultTextEncodingName("UTF-8");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(false);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request != null && request.getUrl() != null) {
                    return handleUrlNavigation(request.getUrl().toString());
                }
                return false;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url != null) {
                    return handleUrlNavigation(url);
                }
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                Log.d(TAG, "WebView page finished loading: " + url);

                String polyfillJs =
                    "(function() {" +
                    "  if (typeof window.ZapNative !== 'undefined') {" +
                    "    window.ZapBridge = window.ZapBridge || window.ZapNative;" +
                    "    window.Android = window.Android || window.ZapNative;" +
                    "  } else if (typeof window.ZapBridge !== 'undefined') {" +
                    "    window.ZapNative = window.ZapNative || window.ZapBridge;" +
                    "    window.Android = window.Android || window.ZapBridge;" +
                    "  }" +
                    "  if (typeof window.ZapAppInit === 'function') window.ZapAppInit();" +
                    "})();";
                if (view != null) {
                    view.evaluateJavascript(polyfillJs, null);
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                if (consoleMessage != null) {
                    String msg = "[WebView JS] " + consoleMessage.message() +
                                 " -- From line " + consoleMessage.lineNumber() +
                                 " of " + consoleMessage.sourceId();
                    Log.d(TAG, msg);
                }
                return true;
            }
        });
    }

    private void setupJavaScriptBridge() {
        webBridge = new WebBridge(this, webView);
        webView.addJavascriptInterface(webBridge, BRIDGE_NAME_NATIVE);
        webView.addJavascriptInterface(webBridge, BRIDGE_NAME_BRIDGE);
        webView.addJavascriptInterface(webBridge, BRIDGE_NAME_ANDROID);
        Log.i(TAG, "Injected JavaScript interfaces: " + BRIDGE_NAME_NATIVE + ", " + BRIDGE_NAME_BRIDGE + ", " + BRIDGE_NAME_ANDROID);
    }

    private void setupNodeRunnerWiring() {
        nodeEventListener = new NodeRunner.EventListener() {
            @Override
            public void onEvent(String event, JSONObject data) {
                if (data == null) return;
                try {
                    if ("qr_live".equals(event) || "auth_qr".equals(event)) {
                        String qr = data.optString("svg", "");
                        if (qr.isEmpty()) {
                            qr = data.optString("qr", data.optString("payload", ""));
                        }
                        if (!qr.isEmpty()) {
                            dispatchQrToWebView(qr);
                        }
                    } else if ("pairing_code_live".equals(event) || "auth_pairing_code".equals(event)) {
                        String code = data.optString("formattedCode", "");
                        if (code.isEmpty()) {
                            code = data.optString("code", "");
                        }
                        if (!code.isEmpty()) {
                            dispatchPairingCodeToWebView(code);
                        }
                    } else if ("auth_paired".equals(event)) {
                        dispatchPairingStateToWebView("paired");
                    } else if ("connection".equals(event)) {
                        String status = data.optString("status", "");
                        if ("open".equalsIgnoreCase(status) || "connected".equalsIgnoreCase(status) || "paired".equalsIgnoreCase(status)) {
                            dispatchPairingStateToWebView("paired");
                        }
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error in MainActivity NodeRunner event handler: " + event, e);
                }
            }
        };
        NodeRunner.addEventListener(nodeEventListener);
    }

    public void dispatchQrToWebView(final String qrSvgOrString) {
        if (webBridge != null) {
            webBridge.dispatchQrReceived(qrSvgOrString);
        } else if (webView != null && qrSvgOrString != null && !qrSvgOrString.isEmpty()) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    String script = String.format(
                        "(function(){ if(typeof window.onQrReceived === 'function') window.onQrReceived(%s); })();",
                        JSONObject.quote(qrSvgOrString)
                    );
                    webView.evaluateJavascript(script, null);
                }
            });
        }
    }

    public void dispatchPairingCodeToWebView(final String code) {
        if (webBridge != null) {
            webBridge.dispatchPairingCodeReceived(code);
        } else if (webView != null && code != null && !code.isEmpty()) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    String script = String.format(
                        "(function(){ if(typeof window.onPairingCodeReceived === 'function') window.onPairingCodeReceived(%s); })();",
                        JSONObject.quote(code)
                    );
                    webView.evaluateJavascript(script, null);
                }
            });
        }
    }

    public void dispatchPairingStateToWebView(final String state) {
        final String effectiveState = (state != null && !state.isEmpty()) ? state : "paired";
        if (webBridge != null) {
            webBridge.dispatchPairingStateUpdate(effectiveState);
        } else if (webView != null) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    String script = String.format(
                        "(function(){ if(typeof window.onPairingStateUpdate === 'function') window.onPairingStateUpdate(%s); })();",
                        JSONObject.quote(effectiveState)
                    );
                    webView.evaluateJavascript(script, null);
                }
            });
        }
    }

    public void sendButtonMessage(String to, String text, String buttonsJson) {
        if (webBridge != null) {
            webBridge.sendButtonMessage(to, text, buttonsJson);
        } else {
            NodeRunner.sendButtonMessage(to, text, buttonsJson, null);
        }
    }

    public WebView getWebView() {
        return webView;
    }

    public WebBridge getWebBridge() {
        return webBridge;
    }

    private void loadLocalUiAssets() {
        Log.i(TAG, "Loading local UI asset from: " + ASSET_URL);
        webView.loadUrl(ASSET_URL);
    }

    private boolean handleUrlNavigation(String url) {
        if (url.startsWith("file:///android_asset/")) {
            return false;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Failed to launch external browser for URL: " + url, e);
            return false;
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
            webView.resumeTimers();
        }
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.onPause();
            webView.pauseTimers();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (nodeEventListener != null) {
            NodeRunner.removeEventListener(nodeEventListener);
            nodeEventListener = null;
        }
        if (webBridge != null) {
            webBridge.detach();
            webBridge = null;
        }
        if (webView != null) {
            webView.stopLoading();
            webView.clearHistory();
            webView.loadUrl("about:blank");
            webView.removeJavascriptInterface(BRIDGE_NAME_NATIVE);
            webView.removeJavascriptInterface(BRIDGE_NAME_BRIDGE);
            webView.removeJavascriptInterface(BRIDGE_NAME_ANDROID);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
        Log.i(TAG, "MainActivity onDestroy completed.");
    }
}
