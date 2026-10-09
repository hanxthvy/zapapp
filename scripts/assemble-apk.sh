#!/usr/bin/env bash
# [xihanzu-NR]
# ZapApp Android APK Assembler Script
# Compiles Java, generates classes.dex with d8, bundles assets (UI + nodejs-project),
# packages jniLibs (arm64-v8a + x86_64) uncompressed (-0), executes aapt2 link,
# aligns to 16KB with zipalign -P 16 (build-tools 35), signs with RSA 4096-bit release keystore,
# verifies signature, and deploys final APK.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BUILD_TOOLS_DIR="/opt/android-sdk/build-tools/35.0.0"
PLATFORM_JAR="/opt/android-sdk/platforms/android-34/android.jar"
AAPT2="$BUILD_TOOLS_DIR/aapt2"
D8="$BUILD_TOOLS_DIR/d8"
ZIPALIGN="$BUILD_TOOLS_DIR/zipalign"
APKSIGNER="$BUILD_TOOLS_DIR/apksigner"

SRC_JAVA_DIR="$PROJECT_ROOT/android/app/src/main/java"
SRC_RES_DIR="$PROJECT_ROOT/android/app/src/main/res"
SRC_MANIFEST="$PROJECT_ROOT/android/app/src/main/AndroidManifest.xml"
SRC_UI_DIR="$PROJECT_ROOT/ui"
SRC_NODE_DIR="$PROJECT_ROOT/android/app/src/main/assets/nodejs-project"
SRC_JNI_DIR="$PROJECT_ROOT/android/app/src/main/jniLibs"

KEYSTORE="$PROJECT_ROOT/release.keystore"
KS_PASS="zapapp2026release"
KS_ALIAS="zapapp-release"

BUILD_DIR="$PROJECT_ROOT/android/build"
CLASSES_DIR="$BUILD_DIR/classes"
DEX_DIR="$BUILD_DIR/dex"
RES_COMPILED="$BUILD_DIR/res_compiled"
STAGING_ASSETS="$BUILD_DIR/staging_assets"
STAGING_LIBS="$BUILD_DIR/staging_libs"

OUTPUT_APK_LOCAL="$PROJECT_ROOT/zapapp-release.apk"
OUTPUT_APK_PUBLIC="/var/www/hxsting/public/zapapp-release.apk"

echo "=========================================================="
echo "Starting ZapApp APK Assembly (Build-Tools 35, 16KB Aligned)"
echo "=========================================================="

# 1. Clean and initialize build directories
rm -rf "$CLASSES_DIR" "$DEX_DIR" "$RES_COMPILED" "$STAGING_ASSETS" "$STAGING_LIBS"
mkdir -p "$CLASSES_DIR" "$DEX_DIR" "$RES_COMPILED" "$STAGING_ASSETS/ui" "$STAGING_ASSETS/nodejs-project" "$STAGING_LIBS/lib/arm64-v8a" "$STAGING_LIBS/lib/x86_64"

# 2. Compile Java classes with javac
echo "Step 1: Compiling Java sources with javac..."
JAVA_FILES=()
while IFS= read -r -d $'\0' f; do
    JAVA_FILES+=("$f")
done < <(find "$SRC_JAVA_DIR" -name "*.java" -print0)

javac -cp "$PLATFORM_JAR" -d "$CLASSES_DIR" "${JAVA_FILES[@]}"
echo "Java compilation complete: $(find "$CLASSES_DIR" -name "*.class" | wc -l) classes generated."

# 3. Generate classes.dex with d8
echo "Step 2: Generating classes.dex with d8 (build-tools 35)..."
CLASS_FILES=()
while IFS= read -r -d $'\0' f; do
    CLASS_FILES+=("$f")
done < <(find "$CLASSES_DIR" -name "*.class" -print0)

"$D8" --output "$DEX_DIR" --lib "$PLATFORM_JAR" "${CLASS_FILES[@]}"
ls -lh "$DEX_DIR/classes.dex"

# 4. Compile Android resources with aapt2
echo "Step 3: Compiling Android resources with aapt2..."
"$AAPT2" compile --dir "$SRC_RES_DIR" -o "$RES_COMPILED/resources.zip"

# 5. Prepare assets (UI + nodejs-project)
echo "Step 4: Staging UI assets and nodejs-project runtime..."
cp -rf "$SRC_UI_DIR"/* "$STAGING_ASSETS/ui/"
rm -f "$STAGING_ASSETS/ui"/test_*.js
cp -f "$SRC_UI_DIR/index.html" "$STAGING_ASSETS/index.html"
cp -rf "$SRC_NODE_DIR"/* "$STAGING_ASSETS/nodejs-project/"

# 6. Link APK with aapt2 including assets
echo "Step 5: Linking base APK with aapt2 link..."
"$AAPT2" link \
    -I "$PLATFORM_JAR" \
    --manifest "$SRC_MANIFEST" \
    -A "$STAGING_ASSETS" \
    -o "$BUILD_DIR/base.apk" \
    "$RES_COMPILED/resources.zip" \
    --auto-add-overlay

# 7. Add classes.dex to APK
echo "Step 6: Packaging classes.dex..."
cp -f "$BUILD_DIR/base.apk" "$BUILD_DIR/zapapp_unaligned.apk"
zip -uj "$BUILD_DIR/zapapp_unaligned.apk" "$DEX_DIR/classes.dex"

# 8. Bundle jniLibs (arm64-v8a + x86_64) uncompressed (-0)
echo "Step 7: Bundling uncompressed (-0) jniLibs for 16KB compliance..."
cp -f "$SRC_JNI_DIR/arm64-v8a/libnode.so" "$STAGING_LIBS/lib/arm64-v8a/"
cp -f "$SRC_JNI_DIR/arm64-v8a/libzapapp_core.so" "$STAGING_LIBS/lib/arm64-v8a/"
cp -f "$SRC_JNI_DIR/x86_64/libnode.so" "$STAGING_LIBS/lib/x86_64/"
cp -f "$SRC_JNI_DIR/x86_64/libzapapp_core.so" "$STAGING_LIBS/lib/x86_64/"

(cd "$STAGING_LIBS" && zip -ur -0 "$BUILD_DIR/zapapp_unaligned.apk" lib)

# 9. Execute zipalign with 16KB page-size alignment (-P 16)
echo "Step 8: Executing zipalign -P 16 with build-tools 35..."
"$ZIPALIGN" -P 16 -f -v 4 "$BUILD_DIR/zapapp_unaligned.apk" "$BUILD_DIR/zapapp_aligned.apk"

echo "Verifying 16KB page-alignment:"
"$ZIPALIGN" -c -P 16 -v 4 "$BUILD_DIR/zapapp_aligned.apk" | grep -E "lib/|Verification"

# 10. Sign with release.keystore (RSA 4096-bit) via apksigner (v1, v2, v3 schemes)
echo "Step 9: Signing APK with release.keystore (v1, v2, v3)..."
cp -f "$BUILD_DIR/aligned.apk" "$BUILD_DIR/zapapp_signed.apk" 2>/dev/null || cp -f "$BUILD_DIR/zapapp_aligned.apk" "$BUILD_DIR/zapapp_signed.apk"
"$APKSIGNER" sign \
    --ks "$KEYSTORE" \
    --ks-key-alias "$KS_ALIAS" \
    --ks-pass "pass:$KS_PASS" \
    --key-pass "pass:$KS_PASS" \
    --v1-signing-enabled true \
    --v2-signing-enabled true \
    --v3-signing-enabled true \
    --v4-signing-enabled false \
    "$BUILD_DIR/zapapp_signed.apk"

# 11. Verify signature with apksigner verify
echo "Step 10: Verifying signature with apksigner..."
"$APKSIGNER" verify --verbose --print-certs "$BUILD_DIR/zapapp_signed.apk"
"$APKSIGNER" verify --verbose --min-sdk-version 23 "$BUILD_DIR/zapapp_signed.apk"

# 12. Deploy final APK
echo "Step 11: Deploying final APK to destination paths..."
cp -f "$BUILD_DIR/zapapp_signed.apk" "$OUTPUT_APK_LOCAL"
chmod 644 "$OUTPUT_APK_LOCAL"

if [ -d "$(dirname "$OUTPUT_APK_PUBLIC")" ]; then
    cp -f "$BUILD_DIR/zapapp_signed.apk" "$OUTPUT_APK_PUBLIC"
    chmod 644 "$OUTPUT_APK_PUBLIC"
    echo "Deployed to public distribution: $OUTPUT_APK_PUBLIC"
fi

echo "=========================================================="
echo "ZapApp APK assembly completed successfully!"
ls -lh "$OUTPUT_APK_LOCAL" "$OUTPUT_APK_PUBLIC"
sha256sum "$OUTPUT_APK_LOCAL"
echo "=========================================================="
