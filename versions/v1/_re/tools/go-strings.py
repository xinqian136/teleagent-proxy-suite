#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
go-strings.py — 解析 Go 二进制里 rip-relative 的字符串引用，还原算法模板。

Go 编译后的字符串常量是 (ptr, len)，ptr 指向 .rdata 里的字节。
反汇编里常见模式：
    lea rax, [rip + disp]     ; rax = 字符串数据地址
    mov qword ptr [rsp+X], rax ; 存 ptr
    mov qword ptr [rsp+X+8], N ; 存 len
我们把 lea 的目标地址解析出来，读出对应字符串。

用法: go-strings.py <exe> <函数名子串> [最大字节]
"""
import sys, os, struct, subprocess, json, glob, re

import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_64
from capstone.x86 import X86_OP_MEM, X86_OP_IMM, X86_REG_RIP

_here = os.path.dirname(os.path.abspath(__file__))


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
    exe = sys.argv[1]
    pat = sys.argv[2]
    maxlen = int(sys.argv[3]) if len(sys.argv) > 3 else 8000

    gofuncs = find_gofuncs()
    funcs = load_funcs(exe, gofuncs)
    idx = [i for i, (a, n) in enumerate(funcs) if pat in n]
    if not idx:
        print('未找到符号'); return
    i = idx[0]
    start, name = funcs[i]
    end = funcs[i + 1][0] if i + 1 < len(funcs) else start + maxlen
    size = min(end - start, maxlen)

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

    print('=== %s ===' % name)
    print('VA 0x%x size %d\n' % (start, size))

    for ins in md.disasm(data, start):
        note = ''
        # lea reg, [rip + disp]  → 目标 VA
        if ins.mnemonic == 'lea' and len(ins.operands) == 2:
            op = ins.operands[1]
            if op.type == X86_OP_MEM and op.mem.base == X86_REG_RIP:
                target = ins.address + ins.size + op.mem.disp
                toff = va_to_off(target)
                if toff is not None:
                    # 试着读一段，找可打印串
                    s = raw[toff:toff + 120]
                    z = s.find(b'\x00')
                    if z > 0:
                        cand = s[:z]
                        if all(32 <= c < 127 for c in cand) and len(cand) >= 1:
                            note = '   ;; STR@0x%x = %r' % (target, cand.decode('ascii'))
        # call target → 符号名
        if ins.mnemonic == 'call' and len(ins.operands) == 1 and ins.operands[0].type == X86_OP_IMM:
            t = ins.operands[0].imm
            nm = fnames.get(t)
            if nm:
                note = '   ;; %s' % nm.split('/')[-1]
        print('  0x%x  %-22s %s %s%s' % (ins.address, ins.bytes.hex(), ins.mnemonic, ins.op_str, note))


# 全局函数表（addr -> name）
fnames = {}


if __name__ == '__main__':
    # 先加载全部函数名用于注解
    exe0 = sys.argv[1]
    gf = find_gofuncs()
    for a, n in load_funcs(exe0, gf):
        fnames[a] = n
    main()
