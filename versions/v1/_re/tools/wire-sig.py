#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
wire-sig.py — 定位运行时签名值与它配套的头名。

签名值是 64 位小写 hex（HMAC-SHA256）。在内存里找到它，
再看它「附近」有哪些字符串 —— 那就是这一组请求头。

用法: wire-sig.py <kernel_pid> [秒数]
"""
import ctypes, re, sys, os, time

k32 = ctypes.windll.kernel32
PQI, PVM = 0x0400, 0x0010
MEM_COMMIT = 0x1000
READABLE = {0x02, 0x04, 0x20, 0x40, 0x80}

HEX64 = re.compile(rb'(?<![0-9a-fA-F])([0-9a-f]{64})(?![0-9a-fA-F])')
# 附近的候选上下文串
NEAR = re.compile(rb'[\x20-\x7e]{4,80}')


class MBI(ctypes.Structure):
    _fields_ = [("BaseAddress", ctypes.c_ulonglong), ("AllocationBase", ctypes.c_ulonglong),
                ("AllocationProtect", ctypes.c_ulong), ("RegionSize", ctypes.c_ulonglong),
                ("State", ctypes.c_ulong), ("Protect", ctypes.c_ulong), ("Type", ctypes.c_ulong)]


def scan(pid, deadline):
    h = k32.OpenProcess(PQI | PVM, False, pid)
    if not h:
        print('OpenProcess failed err=%d' % k32.GetLastError()); return []
    addr = 0; mbi = MBI()
    buf = ctypes.create_string_buffer(1 << 21); nr = ctypes.c_size_t(0)
    hits = []
    seen = set()
    t0 = time.time()
    while addr < 0x7FFFFFFFFFFF:
        if time.time() > deadline:
            break
        if not k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)):
            break
        size = mbi.RegionSize
        if mbi.State == MEM_COMMIT and (mbi.Protect & 0xFF) in READABLE and 0 < size < (1 << 30):
            off = 0
            while off < size:
                chunk = min(len(buf), size - off)
                if k32.ReadProcessMemory(h, ctypes.c_void_p(mbi.BaseAddress + off), buf, chunk, ctypes.byref(nr)):
                    d = buf.raw[:nr.value]
                    for m in HEX64.finditer(d):
                        sig = m.group(1).decode('ascii')
                        if sig in seen:
                            continue
                        seen.add(sig)
                        seg = d[max(0, m.start() - 700):m.end() + 700]
                        ctx = [x.group(0).decode('utf-8', 'replace') for x in NEAR.finditer(seg)]
                        ctx = [c for c in ctx if not re.fullmatch(r'[0-9a-f]{32,}', c)]
                        hits.append((sig, ctx))
                off += chunk
            addr = mbi.BaseAddress + size
        else:
            addr = mbi.BaseAddress + size
    k32.CloseHandle(h)
    return hits


if __name__ == '__main__':
    pid = int(sys.argv[1])
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 120
    hits = scan(pid, time.time() + limit)
    print('[+] 找到 %d 个 64hex 串' % len(hits))
    # 只打印上下文里出现「有意思」的关键词的
    KW = ('sign', 'nonce', 'timestamp', 'token', 'auth', 'super', 'teleai',
          'version', 'device', 'install', 'session', 'message', 'request', 'route')
    for sig, ctx in hits:
        joined = ' '.join(ctx).lower()
        if not any(k in joined for k in KW):
            continue
        print('\n--- sig=%s ---' % sig[:16] + '...' + sig[-8:])
        for c in ctx[:25]:
            if len(c) < 4:
                continue
            print('    ', c[:100])
