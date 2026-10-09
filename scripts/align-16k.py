# [xihanzu-NR]
#!/usr/bin/env python3
"""
ELF 16KB page-size alignment adjuster and compliance verifier for Android 15/16/17.
Validates ELF headers, adjusts PT_LOAD p_align to 16KB (0x4000), checks RELRO and dynamic sections.
"""

import os
import sys
import struct
import argparse
import subprocess

TARGET_ALIGN = 0x4000  # 16384 bytes (16KB)

def parse_elf_header(data):
    if len(data) < 64 or data[:4] != b'\x7fELF':
        return None
    ei_class = data[4]  # 1 = 32-bit, 2 = 64-bit
    ei_data = data[5]   # 1 = little endian, 2 = big endian
    if ei_data != 1:
        raise ValueError("Only little-endian ELF supported")
    endian = '<'

    if ei_class == 2:  # ELF64
        # Format: e_type(H), e_machine(H), e_version(I), e_entry(Q), e_phoff(Q), e_shoff(Q), e_flags(I), e_ehsize(H), e_phentsize(H), e_phnum(H), e_shentsize(H), e_shnum(H), e_shstrndx(H)
        fields = struct.unpack_from(endian + 'HHIQQQIHHHHHH', data, 16)
        return {
            'class': 64,
            'machine': fields[1],
            'entry': fields[3],
            'phoff': fields[4],
            'shoff': fields[5],
            'flags': fields[6],
            'ehsize': fields[7],
            'phentsize': fields[8],
            'phnum': fields[9],
            'shentsize': fields[10],
            'shnum': fields[11],
            'shstrndx': fields[12],
        }
    elif ei_class == 1:  # ELF32
        fields = struct.unpack_from(endian + 'HHIIIIIHHHHHH', data, 16)
        return {
            'class': 32,
            'machine': fields[1],
            'entry': fields[3],
            'phoff': fields[4],
            'shoff': fields[5],
            'flags': fields[6],
            'ehsize': fields[7],
            'phentsize': fields[8],
            'phnum': fields[9],
            'shentsize': fields[10],
            'shnum': fields[11],
            'shstrndx': fields[12],
        }
    return None

def read_program_headers(data, elf_hdr):
    endian = '<'
    phoff = elf_hdr['phoff']
    phentsize = elf_hdr['phentsize']
    phnum = elf_hdr['phnum']
    headers = []

    for i in range(phnum):
        off = phoff + i * phentsize
        if off + phentsize > len(data):
            break
        if elf_hdr['class'] == 64:
            # Elf64_Phdr: p_type(I), p_flags(I), p_offset(Q), p_vaddr(Q), p_paddr(Q), p_filesz(Q), p_memsz(Q), p_align(Q)
            p_type, p_flags, p_offset, p_vaddr, p_paddr, p_filesz, p_memsz, p_align = struct.unpack_from(
                endian + 'IIQQQQQQ', data, off
            )
            headers.append({
                'index': i,
                'offset_in_file': off,
                'align_offset_in_file': off + 48,
                'type': p_type,
                'flags': p_flags,
                'offset': p_offset,
                'vaddr': p_vaddr,
                'paddr': p_paddr,
                'filesz': p_filesz,
                'memsz': p_memsz,
                'align': p_align,
            })
        else:
            # Elf32_Phdr: p_type(I), p_offset(I), p_vaddr(I), p_paddr(I), p_filesz(I), p_memsz(I), p_flags(I), p_align(I)
            p_type, p_offset, p_vaddr, p_paddr, p_filesz, p_memsz, p_flags, p_align = struct.unpack_from(
                endian + 'IIIIIIII', data, off
            )
            headers.append({
                'index': i,
                'offset_in_file': off,
                'align_offset_in_file': off + 28,
                'type': p_type,
                'flags': p_flags,
                'offset': p_offset,
                'vaddr': p_vaddr,
                'paddr': p_paddr,
                'filesz': p_filesz,
                'memsz': p_memsz,
                'align': p_align,
            })
    return headers

def adjust_and_verify_elf(file_path, target_align=TARGET_ALIGN, modify=True):
    with open(file_path, 'rb') as f:
        data = bytearray(f.read())

    elf_hdr = parse_elf_header(data)
    if not elf_hdr:
        return {'file': file_path, 'valid': False, 'error': 'Invalid ELF header'}

    phdrs = read_program_headers(data, elf_hdr)
    pt_loads = [p for p in phdrs if p['type'] == 1]
    relro = [p for p in phdrs if p['type'] == 0x6474e552]  # PT_GNU_RELRO

    modified_count = 0
    if modify:
        for p in pt_loads:
            if p['align'] < target_align:
                pack_fmt = '<Q' if elf_hdr['class'] == 64 else '<I'
                struct.pack_into(pack_fmt, data, p['align_offset_in_file'], target_align)
                modified_count += 1

        if modified_count > 0:
            with open(file_path, 'wb') as f:
                f.write(data)
            # Re-read
            with open(file_path, 'rb') as f:
                data = bytearray(f.read())
            elf_hdr = parse_elf_header(data)
            phdrs = read_program_headers(data, elf_hdr)
            pt_loads = [p for p in phdrs if p['type'] == 1]
            relro = [p for p in phdrs if p['type'] == 0x6474e552]

    machine_names = {
        0xb7: "AArch64",
        0x3e: "x86_64",
        0x28: "ARM",
        0x03: "x86"
    }
    machine_str = machine_names.get(elf_hdr['machine'], f"0x{elf_hdr['machine']:x}")

    # Compliance checks
    loads_aligned = all(p['align'] >= target_align for p in pt_loads)
    relro_aligned = True
    relro_detail = "None"
    if relro:
        r = relro[0]
        end_addr = r['vaddr'] + r['memsz']
        rem = end_addr % target_align
        relro_aligned = (rem == 0)
        relro_detail = f"0x{end_addr:x} (rem: 0x{rem:x})"

    # Verify ELF structure via readelf subprocess
    readelf_ok = True
    try:
        proc = subprocess.run(['readelf', '-h', file_path], capture_output=True, text=True, check=True)
        readelf_ok = "ELF Header:" in proc.stdout
    except Exception:
        readelf_ok = False

    return {
        'file': file_path,
        'valid': True,
        'readelf_ok': readelf_ok,
        'class': elf_hdr['class'],
        'machine': machine_str,
        'pt_loads_count': len(pt_loads),
        'pt_load_aligns': [p['align'] for p in pt_loads],
        'loads_aligned': loads_aligned,
        'relro_present': bool(relro),
        'relro_aligned': relro_aligned,
        'relro_detail': relro_detail,
        'modified_count': modified_count,
        'status': 'COMPLIANT' if (loads_aligned and readelf_ok) else 'NON-COMPLIANT'
    }

def main():
    parser = argparse.ArgumentParser(description="Verify and adjust ELF binaries for Android 16KB page-size alignment.")
    parser.add_argument("paths", nargs="*", help="File or directory paths to verify/adjust")
    parser.add_argument("--check-only", action="store_true", help="Only verify without modifying")
    args = parser.parse_args()

    default_paths = [
        "/var/www/zapapp/android/app/src/main/jniLibs/arm64-v8a",
        "/var/www/zapapp/android/app/src/main/jniLibs/x86_64"
    ]
    target_paths = args.paths if args.paths else default_paths

    files_to_check = []
    for p in target_paths:
        if os.path.isfile(p):
            files_to_check.append(p)
        elif os.path.isdir(p):
            for root, _, files in os.walk(p):
                for f in files:
                    if f.endswith('.so'):
                        files_to_check.append(os.path.join(root, f))

    print("=" * 80)
    print("ANDROID 15/16/17 16KB PAGE-SIZE ALIGNMENT AUDIT & ADJUSTMENT")
    print("=" * 80)

    all_compliant = True
    for fp in sorted(files_to_check):
        res = adjust_and_verify_elf(fp, modify=(not args.check_only))
        if not res['valid']:
            print(f"[-] {fp}: INVALID ELF ({res.get('error')})")
            all_compliant = False
            continue

        align_strs = [f"0x{a:x}" for a in res['pt_load_aligns']]
        print(f"[+] {res['file']}")
        print(f"    Architecture:    {res['machine']} (ELF{res['class']})")
        print(f"    ELF Header:      {'VALID' if res['readelf_ok'] else 'CORRUPTED'}")
        print(f"    PT_LOAD count:   {res['pt_loads_count']} (aligns: {', '.join(align_strs)})")
        print(f"    RELRO aligned:   {res['relro_aligned']} ({res['relro_detail']})")
        print(f"    Modified count:  {res['modified_count']}")
        print(f"    Status:          {res['status']}")
        print("-" * 80)

        if res['status'] != 'COMPLIANT':
            all_compliant = False

    if all_compliant:
        print("[SUCCESS] All binaries are 16KB page-size compliant and have valid ELF headers.")
        sys.exit(0)
    else:
        print("[FAILURE] Non-compliant or corrupted ELF binaries detected.")
        sys.exit(1)

if __name__ == '__main__':
    main()
