#!/usr/bin/env bash
# [xihanzu-NR]
# ZapApp QA E2E APK Validation Script
# Validates signature, 16KB alignment, badging, permissions, and file integrity.

set -euo pipefail

APK_PATH="${1:-/var/www/zapapp/zapapp-release.apk}"
BUILD_TOOLS="/opt/android-sdk/build-tools/35.0.0"
APKSIGNER="$BUILD_TOOLS/apksigner"
ZIPALIGN="$BUILD_TOOLS/zipalign"
AAPT="$BUILD_TOOLS/aapt"

echo "=========================================================="
echo "ZapApp QA E2E Validation: $APK_PATH"
echo "=========================================================="

if [ ! -f "$APK_PATH" ]; then
    echo "ERROR: APK not found at $APK_PATH" >&2
    exit 1
fi

# 1. File Size & Checksums
echo "=== 1. APK Size & Checksums ==="
APK_SIZE=$(stat -c%s "$APK_PATH")
APK_SIZE_HUMAN=$(du -h "$APK_PATH" | cut -f1)
echo "Size: $APK_SIZE bytes ($APK_SIZE_HUMAN)"
SHA256=$(sha256sum "$APK_PATH" | awk '{print $1}')
SHA1=$(sha1sum "$APK_PATH" | awk '{print $1}')
MD5=$(md5sum "$APK_PATH" | awk '{print $1}')
echo "SHA-256: $SHA256"
echo "SHA-1:   $SHA1"
echo "MD5:     $MD5"

# 2. File Integrity (Zip check)
echo "=== 2. Archive File Integrity ==="
unzip -tq "$APK_PATH"
echo "[PASS] Zip integrity check clean"

# 3. apksigner verify --verbose --print-certs
echo "=== 3. apksigner Verification ==="
"$APKSIGNER" verify --verbose --print-certs "$APK_PATH"
echo "[PASS] apksigner verify clean"

# 4. 16KB Page-Size Alignment with zipalign -c -P 16 -v 4
echo "=== 4. 16KB Page-Size Alignment (zipalign -c -P 16 -v 4) ==="
"$ZIPALIGN" -c -P 16 -v 4 "$APK_PATH" > /tmp/zipalign_check.log
if grep -q "Verification succesful" /tmp/zipalign_check.log; then
    echo "[PASS] 16KB page-size alignment verified successfully"
    grep "lib/" /tmp/zipalign_check.log
else
    echo "ERROR: 16KB alignment verification failed!" >&2
    cat /tmp/zipalign_check.log
    exit 1
fi

# 5. aapt package badging & permissions
echo "=== 5. Package Badging & Permissions ==="
"$AAPT" dump badging "$APK_PATH" > /tmp/aapt_badging.log

PKG_NAME=$("$AAPT" dump badging "$APK_PATH" | awk -F"'" '/package: name=/{print $2}')
V_CODE=$("$AAPT" dump badging "$APK_PATH" | awk -F"'" '/versionCode=/{print $4}')
V_NAME=$("$AAPT" dump badging "$APK_PATH" | awk -F"'" '/versionName=/{print $6}')
MIN_SDK=$("$AAPT" dump badging "$APK_PATH" | awk -F"'" '/sdkVersion:/{print $2}')
TARGET_SDK=$("$AAPT" dump badging "$APK_PATH" | awk -F"'" '/targetSdkVersion:/{print $2}')
APP_LABEL=$("$AAPT" dump badging "$APK_PATH" | awk -F"'" '/application-label:/{print $2}')

echo "Package Name:   $PKG_NAME"
echo "Version Code:   $V_CODE"
echo "Version Name:   $V_NAME"
echo "Min SDK:        $MIN_SDK"
echo "Target SDK:     $TARGET_SDK"
echo "App Label:      $APP_LABEL"

echo "Permissions:"
"$AAPT" dump permissions "$APK_PATH"

echo "Native Architectures:"
"$AAPT" dump badging "$APK_PATH" | grep "native-code:"

echo "=========================================================="
echo "ALL QA E2E CHECKS PASSED FOR $APK_PATH"
echo "=========================================================="
