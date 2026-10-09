// [xihanzu-NR]
package com.hxdev.zapapp

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout

/**
 * Main Activity hosting the ZapApp lightweight Single Page Application inside Android WebView.
 * Handles:
 * - Full-screen edge-to-edge layout and status bar styling
 * - Optimized WebView container configuration (DOM storage, JS bridge, hardware acceleration)
 * - Loading local bundled assets from ui/index.html
 * - Injecting JavaScriptInterface (window.ZapNative, window.ZapBridge, window.Android)
 * - Foreground service lifecycle coordination
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var webBridge: WebBridge

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.i(TAG, "MainActivity onCreate: Initializing ZapApp host.")

        // Configure system windows & dark theme status bar matching WhatsApp Web
        configureWindowChrome()

        // Initialize Native Rust Core store & paths
        val dbPath = filesDir.resolve("zapapp.db").absolutePath
        val cachePath = cacheDir.absolutePath
        NativeZapCore.initCore(dbPath, cachePath)

        // Ensure background persistent service is active
        ZapForegroundService.start(this)

        // Setup WebView host
        val rootLayout = FrameLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(COLOR_APP_BACKGROUND)
        }

        webView = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(COLOR_APP_BACKGROUND)
        }

        rootLayout.addView(webView)
        setContentView(rootLayout)

        setupWebViewSettings()
        setupJavaScriptBridge()
        loadLocalUiAssets()
    }

    private fun configureWindowChrome() {
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        window.apply {
            clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS)
            addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
            statusBarColor = COLOR_APP_BACKGROUND
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                navigationBarColor = COLOR_APP_BACKGROUND
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebViewSettings() {
        webView.settings.apply {
            // Essential engine permissions
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true

            // Local asset file access
            allowFileAccess = true
            allowContentAccess = true
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = true
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = true

            // Layout & rendering optimization
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false

            // Media & caching
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT

            // Encoding
            defaultTextEncodingName = "UTF-8"

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                safeBrowsingEnabled = false
            }
        }

        // Enable developer debugging in debug builds or development targets
        WebView.setWebContentsDebuggingEnabled(true)

        // Custom WebViewClient for internal asset routing and link interception
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url?.toString() ?: return false
                return handleUrlNavigation(url)
            }

            @Suppress("DEPRECATION")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                if (url == null) return false
                return handleUrlNavigation(url)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                Log.d(TAG, "WebView page finished loading: $url")

                // Ensure window.ZapNative and aliases are uniformly exposed
                val polyfillJs = """
                    (function() {
                        if (typeof window.ZapNative !== 'undefined') {
                            window.ZapBridge = window.ZapBridge || window.ZapNative;
                            window.Android = window.Android || window.ZapNative;
                        } else if (typeof window.ZapBridge !== 'undefined') {
                            window.ZapNative = window.ZapNative || window.ZapBridge;
                            window.Android = window.Android || window.ZapBridge;
                        }
                    })();
                """.trimIndent()
                view?.evaluateJavascript(polyfillJs, null)
            }
        }

        // Custom WebChromeClient to route JavaScript console messages to Logcat
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                consoleMessage?.let {
                    val level = it.messageLevel()
                    val msg = "[WebView JS] ${it.message()} -- From line ${it.lineNumber()} of ${it.sourceId()}"
                    when (level) {
                        ConsoleMessage.MessageLevel.ERROR -> Log.e(TAG, msg)
                        ConsoleMessage.MessageLevel.WARNING -> Log.w(TAG, msg)
                        else -> Log.d(TAG, msg)
                    }
                }
                return true
            }
        }
    }

    private fun setupJavaScriptBridge() {
        webBridge = WebBridge(this, webView)

        // Inject the JavaScriptInterface under standard and aliased names
        webView.addJavascriptInterface(webBridge, BRIDGE_NAME_NATIVE)
        webView.addJavascriptInterface(webBridge, BRIDGE_NAME_BRIDGE)
        webView.addJavascriptInterface(webBridge, BRIDGE_NAME_ANDROID)

        Log.i(TAG, "Injected JavaScript interfaces: $BRIDGE_NAME_NATIVE, $BRIDGE_NAME_BRIDGE, $BRIDGE_NAME_ANDROID")
    }

    private fun loadLocalUiAssets() {
        Log.i(TAG, "Loading local UI asset from: $ASSET_URL")
        webView.loadUrl(ASSET_URL)
    }

    private fun handleUrlNavigation(url: String): Boolean {
        // Keep internal asset navigation inside the WebView
        if (url.startsWith("file:///android_asset/")) {
            return false
        }

        // Open external links in system browser
        return try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(intent)
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to launch external browser for URL: $url", e)
            false
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (this::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    override fun onResume() {
        super.onResume()
        if (this::webView.isInitialized) {
            webView.onResume()
            webView.resumeTimers()
        }
    }

    override fun onPause() {
        if (this::webView.isInitialized) {
            webView.onPause()
            webView.pauseTimers()
        }
        super.onPause()
    }

    override fun onDestroy() {
        if (this::webBridge.isInitialized) {
            webBridge.detach()
        }
        if (this::webView.isInitialized) {
            webView.apply {
                stopLoading()
                clearHistory()
                loadUrl("about:blank")
                removeJavascriptInterface(BRIDGE_NAME_NATIVE)
                removeJavascriptInterface(BRIDGE_NAME_BRIDGE)
                removeJavascriptInterface(BRIDGE_NAME_ANDROID)
                destroy()
            }
        }
        super.onDestroy()
        Log.i(TAG, "MainActivity onDestroy completed.")
    }

    companion object {
        private const val TAG = "ZapMainActivity"

        const val BRIDGE_NAME_NATIVE = "ZapNative"
        const val BRIDGE_NAME_BRIDGE = "ZapBridge"
        const val BRIDGE_NAME_ANDROID = "Android"

        const val ASSET_URL = "file:///android_asset/ui/index.html"
        private const val COLOR_APP_BACKGROUND = 0xFF111B21.toInt() // WhatsApp Web dark theme background
    }
}
