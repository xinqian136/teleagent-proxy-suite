#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
go-disasm.py — 反汇编 Go 二进制里的指定函数。

先跑 gofuncs.exe 导出函数表到 JSON（funcs.json），再离线反汇编。

用法: go-disasm.py <exe> <符号名子串> [最大字节数]
"""
import sys, os, struct, subprocess, json, re, glob

import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_64

_here = os.path.dirname(os.path.abspath(__file__))


def find_gofuncs():
    for c in glob.glob(os.path.join(_here, '..', '**', 'gofuncs.exe'), recursive=True):
        return os.path.abspath(c)
    return None


def load_funcs(exe, gofuncs):
    """跑 gofuncs.exe 导出全量函数表。
    注意：不传正则时 gofuncs 只打印前 40 条，所以用 '.*' 匹配全部。"""
    cache = os.path.join(_here, 'funcs.json')
    if os.path.exists(cache) and os.path.getmtime(cache) > os.path.getmtime(exe):
        with open(cache, 'r', encoding='utf-8') as f:
            return json.load(f)
    r = subprocess.run([gofuncs, exe, '.*'], capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    funcs = []
    for line in r.stdout.splitlines():
        if line.startswith('0x') and '\t' in line:
            a, n = line.split('\t', 1)
            try:
                funcs.append((int(a, 16), n.strip()))
            except ValueError:
                pass
    with open(cache, 'w', encoding='utf-8') as f:
        json.dump(funcs, f)
    return funcs


def main():
    exe = sys.argv[1]
    pat = sys.argv[2]
    maxlen = int(sys.argv[3]) if len(sys.argv) > 3 else 4096

    gofuncs = find_gofuncs()
    if not gofuncs:
        print('[!] 找不到 gofuncs.exe'); return
    funcs = load_funcs(exe, gofuncs)
    print('[+] 函数表 %d 条' % len(funcs))

    idx = [i for i, (a, n) in enumerate(funcs) if pat in n]
    if not idx:
        print('未找到符号 %r' % pat); return
    i = idx[0]
    start, name = funcs[i]
    end = funcs[i + 1][0] if i + 1 < len(funcs) else start + maxlen
    size = min(end - start, maxlen)
    print('=== %s ===' % name)
    print('VA 0x%x  size %d bytes  (next func at 0x%x)' % (start, size, end))

    pe = pefile.PE(exe, fast_load=True)
    ib = pe.OPTIONAL_HEADER.ImageBase
    rva = start - ib
    off = None
    for s in pe.sections:
        vsz = max(s.Misc_VirtualSize, s.SizeOfRawData)
        if s.VirtualAddress <= rva < s.VirtualAddress + vsz:
            off = s.PointerToRawData + (rva - s.VirtualAddress)
            break
    if off is None:
        print('无法映射地址'); return

    data = open(exe, 'rb').read()[off:off + size]
    md = Cs(CS_ARCH_X86, CS_MODE_64)
    for ins in md.disasm(data, start):
        print('  0x%x  %-22s %s %s' % (ins.address, ins.bytes.hex(), ins.mnemonic, ins.op_str))


if __name__ == '__main__':
    main()
