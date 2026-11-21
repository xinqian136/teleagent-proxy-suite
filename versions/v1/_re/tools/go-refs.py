#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
go-refs.py — 提取一个函数里所有 rip-relative lea 指向的字符串（含长度推断）。

Go 字符串布局：lea 载入 ptr，紧接着（在同一基本块里）mov qword [rsp+X], <len>
本脚本对每个 lea 目标，读 64 字节 printable 前缀，并尝试用常见长度（1..64）
找出完整字符串；同时把「该地址在 .rdata 中的原始 hex」给出，便于人工确认。

用法: go-refs.py <exe> <函数名子串>
"""
import sys, os, struct, subprocess, json, glob, re

import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_64
from capstone.x86 import X86_OP_MEM, X86_OP_IMM, X86_REG_RIP

_here = os.path.dirname(os.path.abspath(__file__))
fnames = {}


def find_gofuncs():
    for c in glob.glob(os.path.join(_here, '..', '**', 'gofuncs.exe'), recursive=True):
        return os.path.abspath(c)
    return None


def load_funcs(exe, gofuncs):
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
    exe, pat = sys.argv[1], sys.argv[2]
    gofuncs = find_gofuncs()
    funcs = load_funcs(exe, gofuncs)
    for a, n in funcs:
        fnames[a] = n

    idx = [i for i, (a, n) in enumerate(funcs) if pat in n]
    if not idx:
        print('未找到符号'); return
    i = idx[0]
    start, name = funcs[i]
    end = funcs[i + 1][0] if i + 1 < len(funcs) else start + 0x2000
    size = end - start

    pe = pefile.PE(exe, fast_load=True)
    ib = pe.OPTIONAL_HEADER.ImageBase
    raw = open(exe, 'rb').read()

    def va_to_off(va):
        rva = va - ib
        for s in pe.sections:
            vsz = max(s.Misc_VirtualSize, s.SizeOfRawData)
            if s.VirtualAddress <= rva < s.VirtualAddress + vsz:
                return s.PointerToRawData + (rva - s.VirtualAddress)
        return None

    off = va_to_off(start)
    data = raw[off:off + size]
    md = Cs(CS_ARCH_X86, CS_MODE_64)
    md.detail = True

    print('=== %s @0x%x ===' % (name, start))

    # 第一遍：收集 lea rip 目标 + 紧随的长度立即数
    insns = list(md.disasm(data, start))
    refs = []
    for k, ins in enumerate(insns):
        if ins.mnemonic != 'lea' or len(ins.operands) != 2:
            continue
        op = ins.operands[1]
        if op.type != X86_OP_MEM or op.mem.base != X86_REG_RIP:
            continue
        target = ins.address + ins.size + op.mem.disp
        # 往后看 6 条，找 mov [rsp+X], imm（长度）
        length = None
        for m in insns[k + 1:k + 8]:
            if m.mnemonic == 'mov' and len(m.operands) == 2 and m.operands[1].type == X86_OP_IMM:
                v = m.operands[1].imm
                if 0 < v < 4096:
                    length = v
                    break
        refs.append((ins.address, target, length))

    seen = set()
    for addr, target, length in refs:
        if target in seen:
            continue
        seen.add(target)
        toff = va_to_off(target)
        if toff is None:
            print('  0x%x -> 0x%x (不可映射)' % (addr, target))
            continue
        blob = raw[toff:toff + 96]
        z = blob.find(b'\x00')
        printable = blob[:z] if z > 0 else blob
        ok = all(32 <= c < 127 or c in (9, 10, 13) for c in printable[:max(length or 0, 1)])
        s = printable[:length].decode('utf-8', 'replace') if length else printable[:48].decode('utf-8', 'replace')
        print('  0x%x  STR@0x%-12x len=%-5s %r %s' % (addr, target, length, s, '' if ok else '(非文本)'))


if __name__ == '__main__':
    main()
