#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
heap-ctx.py — 在进程内存的 HEAP 段里找字符串，并打印其邻近的完整内容。

用途：Go 的 http.Header 是 map[string][]string，运行时头名/值在堆上相邻。
找到 "X-Route-Target" 附近的堆内容，就能还原真实请求头集合。

用法: heap-ctx.py <pid> <needle> [秒数] [最大命中数]
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


def scan_heap(pid, needle, deadline, maxhits):
    h = k32.OpenProcess(PQI | PVM, False, pid)
    if not h:
        print('OpenProcess failed err=%d' % k32.GetLastError()); return []
    addr = 0; mbi = MBI()
    buf = ctypes.create_string_buffer(1 << 21); nr = ctypes.c_size_t(0)
    out = []
    while addr < 0x7FFFFFFFFFFF and len(out) < maxhits:
        if time.time() > deadline:
            break
        if not k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)):
            break
        size = mbi.RegionSize
        if mbi.State == MEM_COMMIT and (mbi.Protect & 0xFF) in READABLE and mbi.Type != IMAGE and 0 < size < (1 << 30):
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
                        out.append((mbi.BaseAddress + off + i, d, i))
                        i += 1
                        if len(out) >= maxhits:
                            break
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
    maxhits = int(sys.argv[4]) if len(sys.argv) > 4 else 8
    hits = scan_heap(pid, needle, time.time() + limit, maxhits)
    print('[+] HEAP 命中 %d 处' % len(hits))
    for va, d, i in hits:
        print('\n================ VA 0x%x ================' % va)
        seg = d[max(0, i - 1200):i + 1200]
        # 打印可打印串序列
        for m in re.finditer(rb'[\x20-\x7e]{3,}', seg):
            s = m.group(0).decode('utf-8', 'replace')
            print('   ', s[:140])
