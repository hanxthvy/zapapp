# [xihanzu-NR]
# Preserve JNI export symbols for NativeZapCore
-keepclasseswithmembernames class * {
    native <methods>;
}

-keep class com.hxdev.zapapp.NativeZapCore { *; }

# Preserve WebView JavaScriptInterface bridge methods
-keepclassmembers class com.hxdev.zapapp.WebBridge {
    @android.webkit.JavascriptInterface <methods>;
}

# AndroidX and Kotlin reflection guards
-keepattributes *Annotation*
-keepattributes JavascriptInterface
