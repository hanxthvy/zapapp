#!/usr/bin/env bash
# [xihanzu-NR]
# Automated build script for ZapApp Android APK.
# Steps:
# 1. Cross-compiles Rust core (zapapp_core) using cargo-ndk for Android ABIs.
# 2. Copies resulting .so shared libraries into app/src/main/jniLibs.
# 3. Bundles Web UI assets into app/src/main/assets/ui.
# 4. Executes Gradle assemble to generate the final APK.

set -euo pipefail

# Project directory resolution
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CORE_DIR="$PROJECT_ROOT/core"
UI_DIR="$PROJECT_ROOT/ui"
ANDROID_DIR="$PROJECT_ROOT/android"
APP_DIR="$ANDROID_DIR/app"
JNI_LIBS_DIR="$APP_DIR/src/main/jniLibs"
ASSETS_DIR="$APP_DIR/src/main/assets"

# Default configuration
# ponytail: default 4 standard Android ABIs; upgrade to ABI split filtering on demand
DEFAULT_ABIS=("arm64-v8a" "armeabi-v7a" "x86_64" "x86")
TARGET_ABIS=("${DEFAULT_ABIS[@]}")
BUILD_TYPE="release"
SKIP_RUST=false
SKIP_UI=false
SKIP_GRADLE=false
CUSTOM_NDK_PATH=""

# Ensure local cargo path is accessible
if [ -d "$HOME/.cargo/bin" ]; then
    export PATH="$HOME/.cargo/bin:$PATH"
fi

# Usage guide
usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Automated build pipeline for ZapApp Android APK.

Options:
  --debug, -d           Build in Debug mode (default: Release)
  --release, -r         Build in Release mode (default)
  --abi <abi[,abi]>     Target specific Android ABI(s) (e.g. arm64-v8a, x86_64, or all)
  --skip-rust           Skip Rust core cross-compilation step
  --skip-ui             Skip UI assets bundling step
  --skip-gradle         Skip Gradle assemble execution
  --ndk-path <path>     Explicitly set path to Android NDK
  -h, --help            Show this help message
EOF
    exit 0
}

# Parse command line flags
while [[ $# -gt 0 ]]; do
    case "$1" in
        --debug|-d)
            BUILD_TYPE="debug"
            shift
            ;;
        --release|-r)
            BUILD_TYPE="release"
            shift
            ;;
        --abi)
            IFS=',' read -r -a TARGET_ABIS <<< "$2"
            shift 2
            ;;
        --skip-rust)
            SKIP_RUST=true
            shift
            ;;
        --skip-ui)
            SKIP_UI=true
            shift
            ;;
        --skip-gradle)
            SKIP_GRADLE=true
            shift
            ;;
        --ndk-path)
            CUSTOM_NDK_PATH="$2"
            shift 2
            ;;
        -h|--help)
            usage
            ;;
        *)
            echo "Error: Unknown argument '$1'" >&2
            usage
            ;;
    esac
done

# Map Android ABI to Rust target triple
abi_to_target() {
    case "$1" in
        arm64-v8a)   echo "aarch64-linux-android" ;;
        armeabi-v7a) echo "armv7-linux-androideabi" ;;
        x86_64)      echo "x86_64-linux-android" ;;
        x86)         echo "i686-linux-android" ;;
        *)           echo "" ;;
    esac
}

# Resolve Android NDK location
locate_ndk() {
    if [ -n "$CUSTOM_NDK_PATH" ] && [ -d "$CUSTOM_NDK_PATH" ]; then
        export ANDROID_NDK_HOME="$CUSTOM_NDK_PATH"
        export NDK_HOME="$CUSTOM_NDK_PATH"
        return 0
    fi

    if [ -n "${ANDROID_NDK_HOME:-}" ] && [ -d "$ANDROID_NDK_HOME" ]; then
        export NDK_HOME="$ANDROID_NDK_HOME"
        return 0
    fi

    if [ -n "${NDK_HOME:-}" ] && [ -d "$NDK_HOME" ]; then
        export ANDROID_NDK_HOME="$NDK_HOME"
        return 0
    fi

    local search_roots=(
        "${ANDROID_HOME:-}/ndk"
        "${ANDROID_SDK_ROOT:-}/ndk"
        "$HOME/Android/Sdk/ndk"
        "/opt/android-sdk/ndk"
        "/opt/android-ndk"
        "/usr/local/share/android-ndk"
    )

    for root in "${search_roots[@]}"; do
        if [ -d "$root" ]; then
            local latest
            latest=$(find "$root" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -n 1 || true)
            if [ -n "$latest" ] && [ -d "$latest" ]; then
                export ANDROID_NDK_HOME="$latest"
                export NDK_HOME="$latest"
                return 0
            fi
        fi
    done

    return 1
}

# Step 1: Cross-compile Rust core with cargo-ndk and copy .so to jniLibs
compile_rust_core() {
    echo "=========================================================="
    echo "Step 1: Cross-compiling Rust core via cargo-ndk ($BUILD_TYPE)"
    echo "=========================================================="

    if ! command -v cargo >/dev/null 2>&1; then
        echo "Error: 'cargo' toolchain not found in PATH." >&2
        exit 1
    fi

    if ! command -v cargo-ndk >/dev/null 2>&1 && ! cargo ndk --version >/dev/null 2>&1; then
        echo "cargo-ndk not found. Installing via cargo install cargo-ndk..."
        cargo install cargo-ndk
    fi

    if ! locate_ndk; then
        echo "Error: Android NDK not detected. Set ANDROID_NDK_HOME or pass --ndk-path." >&2
        echo "Example: export ANDROID_NDK_HOME=/path/to/android-ndk" >&2
        exit 1
    fi
    echo "Using Android NDK: $ANDROID_NDK_HOME"

    export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-Wl,-z,max-page-size=16384 -C link-arg=-Wl,-z,common-page-size=16384"

    local cargo_profile="release"
    local cargo_flags=("--manifest-path" "$CORE_DIR/Cargo.toml")
    if [ "$BUILD_TYPE" = "release" ]; then
        cargo_flags+=("--release")
    else
        cargo_profile="debug"
    fi

    mkdir -p "$JNI_LIBS_DIR"

    for abi in "${TARGET_ABIS[@]}"; do
        local target_triple
        target_triple=$(abi_to_target "$abi")
        if [ -z "$target_triple" ]; then
            echo "Warning: Unknown ABI '$abi', skipping."
            continue
        fi

        echo "--- Target ABI: $abi ($target_triple) ---"

        # Ensure rustup target is installed
        if command -v rustup >/dev/null 2>&1; then
            if ! rustup target list --installed | grep -q "^$target_triple\$"; then
                echo "Adding rustup target '$target_triple'..."
                rustup target add "$target_triple"
            fi
        fi

        # Execute cargo-ndk cross-compilation
        echo "Running cargo-ndk for $abi..."
        cargo ndk -t "$abi" -o "$JNI_LIBS_DIR" build "${cargo_flags[@]}"

        # Copy and verify .so output in jniLibs
        local target_so="$PROJECT_ROOT/target/$target_triple/$cargo_profile/libzapapp_core.so"
        local abi_dir="$JNI_LIBS_DIR/$abi"
        mkdir -p "$abi_dir"

        if [ -f "$target_so" ]; then
            cp -f "$target_so" "$abi_dir/libzapapp_core.so"
        fi

        if [ -f "$abi_dir/libzapapp_core.so" ]; then
            local so_size
            so_size=$(du -h "$abi_dir/libzapapp_core.so" | cut -f1)
            echo "Installed: $abi_dir/libzapapp_core.so ($so_size)"
        else
            echo "Error: Native library $abi_dir/libzapapp_core.so was not created." >&2
            exit 1
        fi
    done

    # Verify and ensure 16KB page-size alignment for Android 15/16/17
    if [ -f "$SCRIPT_DIR/align-16k.py" ]; then
        echo "Verifying and aligning JNI libraries for Android 15/16/17 (16KB page-size)..."
        python3 "$SCRIPT_DIR/align-16k.py" "$JNI_LIBS_DIR"
    fi
}

# Step 2: Bundle UI assets into android assets
bundle_ui_assets() {
    echo "=========================================================="
    echo "Step 2: Bundling UI assets into Android assets"
    echo "=========================================================="

    if [ ! -d "$UI_DIR" ]; then
        echo "Error: UI source directory '$UI_DIR' not found." >&2
        exit 1
    fi

    local target_ui_dir="$ASSETS_DIR/ui"
    mkdir -p "$target_ui_dir"

    echo "Syncing UI assets to $target_ui_dir..."
    # Copy web assets (HTML, CSS, JS)
    cp -f "$UI_DIR/index.html" "$target_ui_dir/index.html"

    if [ -d "$UI_DIR/css" ]; then
        mkdir -p "$target_ui_dir/css"
        cp -rf "$UI_DIR/css"/* "$target_ui_dir/css/"
    fi

    if [ -d "$UI_DIR/js" ]; then
        mkdir -p "$target_ui_dir/js"
        cp -rf "$UI_DIR/js"/* "$target_ui_dir/js/"
    fi

    # Ensure root asset index.html points to ui/index.html
    ln -sf "ui/index.html" "$ASSETS_DIR/index.html"

    echo "Assets bundled:"
    find "$target_ui_dir" -type f | sed 's|^|  - |'
}

# Step 3: Run Gradle assemble
run_gradle_assemble() {
    echo "=========================================================="
    echo "Step 3: Running Gradle assemble ($BUILD_TYPE)"
    echo "=========================================================="

    cd "$ANDROID_DIR"

    local gradle_bin=""
    if [ -x "./gradlew" ]; then
        gradle_bin="./gradlew"
    elif command -v gradle >/dev/null 2>&1; then
        gradle_bin="gradle"
    else
        echo "Error: Neither ./gradlew nor system 'gradle' found in PATH." >&2
        echo "Please install Gradle or generate the Gradle wrapper." >&2
        exit 1
    fi

    local assemble_task="assembleRelease"
    if [ "$BUILD_TYPE" = "debug" ]; then
        assemble_task="assembleDebug"
    fi

    echo "Running: $gradle_bin $assemble_task"
    "$gradle_bin" "$assemble_task"

    echo "Gradle build completed."
    local apk_dir="$APP_DIR/build/outputs/apk/$BUILD_TYPE"
    if [ -d "$apk_dir" ]; then
        echo "Generated APK files:"
        find "$apk_dir" -name "*.apk" | sed 's|^|  - |'
    fi
}

# Main pipeline execution
main() {
    echo "Starting ZapApp Android Build Pipeline..."
    echo "Project root: $PROJECT_ROOT"
    echo "Build type:   $BUILD_TYPE"
    echo "Target ABIs:  ${TARGET_ABIS[*]}"

    if [ "$SKIP_RUST" = false ]; then
        compile_rust_core
    else
        echo "Skipping Step 1: Rust cross-compilation (--skip-rust)"
    fi

    if [ "$SKIP_UI" = false ]; then
        bundle_ui_assets
    else
        echo "Skipping Step 2: UI assets bundling (--skip-ui)"
    fi

    if [ "$SKIP_GRADLE" = false ]; then
        run_gradle_assemble
    else
        echo "Skipping Step 3: Gradle assemble (--skip-gradle)"
    fi

    echo "=========================================================="
    echo "ZapApp Android build pipeline completed successfully."
    echo "=========================================================="
}

main
