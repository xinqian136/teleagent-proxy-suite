#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
find-str.py — 在进程内存里定位一个字符串，并报告它所在的区域类型与邻近内容。

用法: find-str.py <pid> <needle> [秒数]
"""
import ctypes, re, sys, os, time

k32 = ctypes.windll.kernel32
PQI, PVM = 0x0400, 0x0010
MEM_COMMIT = 0x1000
READABLE = {0x02, 0x04, 0x20, 0x40, 0x80}
IMAGE = 0x1000000


class MBI(ctypes.Structure):
    _fields_ = [("BaseAddress", ctypes.c_ulonglong), ("AllocationBase", ctypes.c_ulonglong),
                ("AllocationProtect", ctypes.c_ulong), ("RegionSize", ctypes.c_ulonglong),
                ("State", ctypes.c_ulong), ("Protect", ctypes.c_ulong), ("Type", ctypes.c_ulong)]


def scan(pid, needle, deadline):
    h = k32.OpenProcess(PQI | PVM, False, pid)
    if not h:
        print('OpenProcess failed err=%d' % k32.GetLastError()); return []
    addr = 0; mbi = MBI()
    buf = ctypes.create_string_buffer(1 << 21); nr = ctypes.c_size_t(0)
    out = []
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
                    i = 0
                    while True:
                        i = d.find(needle, i)
                        if i < 0:
                            break
                        out.append((mbi.BaseAddress + off + i, mbi.Type, mbi.Protect, d))
                        i += 1
                off += chunk
            addr = mbi.BaseAddress + size
        else:
            addr = mbi.BaseAddress + size
    k32.CloseHandle(h)
    return out


if __name__ == '__main__':
    pid = int(sys.argv[1])
    needle = sys.argv[2].encode()
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else 120
    hits = scan(pid, needle, time.time() + limit)
    print('[+] 命中 %d 处' % len(hits))
    seen_ctx = set()
    for va, typ, prot, d in hits:
        kind = 'IMAGE' if typ == IMAGE else 'HEAP'
        # 取前后 400 字节的可打印串
        # 注意 d 是整个 chunk，va 相对 chunk 起点的偏移未知；用上下文近似
        print('   VA 0x%x  %s  prot=0x%x' % (va, kind, prot))
    # 打印每个命中附近的字符串
    print('\n=== 上下文 ===')
    for va, typ, prot, d in hits[:20]:
        i = d.find(needle)
        seg = d[max(0, i - 400):i + 400]
        strs = [m.group(0).decode('utf-8', 'replace') for m in re.finditer(rb'[\x20-\x7e]{4,}', seg)]
        key = tuple(strs[:12])
        if key in seen_ctx:
            continue
        seen_ctx.add(key)
        print('\n--- VA 0x%x ---' % va)
        for s in strs:
            print('   ', s[:110])
