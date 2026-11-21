#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
wire-headers.py — 扫内核运行时内存，收集实际存在的 HTTP 头名与关键值。

思路：Go 的 http.Request.Header 是 map[string][]string，key 和 value 都是
独立的 Go 字符串（ptr+len）。内存里能找到这些字符串。

关键：排除「来自二进制映像只读段」的名字（那是常量池，不是运行时头），
只报运行时会动态生成的。

用法: wire-headers.py <kernel_pid>
"""
import ctypes, re, sys, os
from ctypes import wintypes

k32 = ctypes.windll.kernel32
PQI, PVM = 0x0400, 0x0010
MEM_COMMIT = 0x1000
READABLE = {0x02, 0x04, 0x20, 0x40, 0x80}

HEADER_RE = re.compile(rb'(?<![A-Za-z0-9_-])([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+){1,6})(?![A-Za-z0-9_-])')
TOKENISH = re.compile(rb'(Bearer\s+[A-Za-z0-9._\-]{8,}|eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}|pt_[A-Za-z0-9]{40,})')
AUTHISH = re.compile(rb'(superagent-auth-v1|SUPERAGENT-AUTH-V1)')
SCHEMEISH = re.compile(rb'(ops-gateway|super-agent/[\d.]+)')


class MBI(ctypes.Structure):
    _fields_ = [("BaseAddress", ctypes.c_ulonglong), ("AllocationBase", ctypes.c_ulonglong),
                ("AllocationProtect", ctypes.c_ulong), ("RegionSize", ctypes.c_ulonglong),
                ("State", ctypes.c_ulong), ("Protect", ctypes.c_ulong), ("Type", ctypes.c_ulong)]


def scan(pid, patterns):
    h = k32.OpenProcess(PQI | PVM, False, pid)
    if not h:
        print('OpenProcess failed err=%d' % k32.GetLastError())
        return
    addr = 0
    mbi = MBI()
    buf = ctypes.create_string_buffer(1 << 21)
    nr = ctypes.c_size_t(0)
    hits = {name: {} for name, _ in patterns}
    while addr < 0x7FFFFFFFFFFF:
        if not k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)):
            break
        size = mbi.RegionSize
        if mbi.State == MEM_COMMIT and (mbi.Protect & 0xFF) in READABLE and 0 < size < (1 << 30):
            off = 0
            while off < size:
                chunk = min(len(buf), size - off)
                if k32.ReadProcessMemory(h, ctypes.c_void_p(mbi.BaseAddress + off), buf, chunk, ctypes.byref(nr)):
                    d = buf.raw[:nr.value]
                    for name, rx in patterns:
                        for m in rx.finditer(d):
                            s = m.group(1) if rx.groups else m.group(0)
                            key = s[:120]
                            if key not in hits[name]:
                                hits[name][key] = m.start()
                off += chunk
        addr = mbi.BaseAddress + size
    k32.CloseHandle(h)
    return hits


if __name__ == '__main__':
    pid = int(sys.argv[1])
    pats = [
        ('X-headers', HEADER_RE),
        ('tokens', TOKENISH),
        ('scheme', AUTHISH),
        ('ua', SCHEMEISH),
    ]
    res = scan(pid, pats)
    for name, d in res.items():
        print('=== %s (%d) ===' % (name, len(d)))
        for k in sorted(d)[:60]:
            print('   ', k.decode('ascii', 'replace'))
        print()
