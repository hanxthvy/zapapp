#!/usr/bin/env bash
# [xihanzu-NR]
# 16KB ELF alignment verification script for Android 15/16/17 compliance.

set -euo pipefail

JNI_DIR="/var/www/zapapp/android/app/src/main/jniLibs"
TARGET_ALIGN=16384 # 0x4000 (16KB)

echo "=== Verifying 16KB Page-Size Alignment for Android 15/16/17 ==="

FAIL=0

check_binary() {
    local file="$1"
    local abi="$2"
    local name="$(basename "$file")"

    if [ ! -f "$file" ]; then
        echo "[-] Missing binary: $file"
        FAIL=1
        return
    fi

    # 1. ELF Header validation
    if ! readelf -h "$file" >/dev/null 2>&1; then
        echo "[-] Corrupted or invalid ELF header: $file"
        FAIL=1
        return
    fi

    local elf_class=$(readelf -h "$file" | awk '/Class:/ {print $2}')
    local elf_machine=$(readelf -h "$file" | awk -F: '/Machine:/ {print $2}' | xargs)

    # 2. Check each PT_LOAD segment alignment
    local aligns=$(readelf -lW "$file" | awk '/LOAD/ {print $NF}')
    local all_aligned=true
    for a in $aligns; do
        local dec_align=$((a))
        if [ "$dec_align" -lt "$TARGET_ALIGN" ]; then
            all_aligned=false
        fi
    done

    # 3. Check GNU_RELRO segment if present
    local relro_ok=true
    local relro_line=$(readelf -lW "$file" | grep "GNU_RELRO" || true)
    if [ -n "$relro_line" ]; then
        local vaddr=$(echo "$relro_line" | awk '{print $3}')
        local memsz=$(echo "$relro_line" | awk '{print $6}')
        local end_addr=$((vaddr + memsz))
        local rem=$((end_addr % TARGET_ALIGN))
        if [ "$rem" -ne 0 ]; then
            relro_ok=false
        fi
    fi

    if [ "$all_aligned" = true ]; then
        echo "[+] $abi/$name: ALIGNED (16KB, $elf_class, $elf_machine, RELRO_ALIGNED: $relro_ok)"
    else
        echo "[-] $abi/$name: MISALIGNED (alignments: $aligns)"
        FAIL=1
    fi
}

for abi in arm64-v8a x86_64; do
    check_binary "$JNI_DIR/$abi/libzapapp_core.so" "$abi"
    check_binary "$JNI_DIR/$abi/libnode.so" "$abi"
done

if [ "$FAIL" -eq 0 ]; then
    echo "=== All arm64-v8a and x86_64 binaries are 16KB ALIGNED and compliant ==="
    exit 0
else
    echo "=== Alignment verification FAILED ==="
    exit 1
fi
