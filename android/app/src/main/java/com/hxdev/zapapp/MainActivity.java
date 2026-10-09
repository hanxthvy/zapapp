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

import java.io.File;

/**
 * Main Activity hosting the ZapApp lightweight Single Page Application inside Android WebView.
 * Handles:
 * - Full-screen edge-to-edge layout and status bar styling
 * - Optimized WebView container configuration (DOM storage, JS bridge, hardware acceleration)
 * - Loading local bundled assets from ui/index.html
 * - Injecting JavaScriptInterface (window.ZapNative, window.ZapBridge, window.Android)
 * - Foreground service lifecycle coordination
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
        if (webBridge != null) {
            webBridge.detach();
        }
        if (webView != null) {
            webView.stopLoading();
            webView.clearHistory();
            webView.loadUrl("about:blank");
            webView.removeJavascriptInterface(BRIDGE_NAME_NATIVE);
            webView.removeJavascriptInterface(BRIDGE_NAME_BRIDGE);
            webView.removeJavascriptInterface(BRIDGE_NAME_ANDROID);
            webView.destroy();
        }
        super.onDestroy();
        Log.i(TAG, "MainActivity onDestroy completed.");
    }
}
