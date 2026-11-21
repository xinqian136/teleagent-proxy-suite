#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
dump-json.py — 在进程内存里找一段以 key 开头的 JSON 并完整打印。

用法: dump-json.py <pid> <start_marker> [秒数]
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


def scan(pid, marker, deadline, maxhits=6):
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
        if mbi.State == MEM_COMMIT and (mbi.Protect & 0xFF) in READABLE and 0 < size < (1 << 30):
            off = 0
            while off < size:
                chunk = min(len(buf), size - off)
                if k32.ReadProcessMemory(h, ctypes.c_void_p(mbi.BaseAddress + off), buf, chunk, ctypes.byref(nr)):
                    d = buf.raw[:nr.value]
                    i = 0
                    while True:
                        i = d.find(marker, i)
                        if i < 0:
                            break
                        out.append((mbi.BaseAddress + off + i, mbi.Type, d, i))
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
    marker = sys.argv[2].encode()
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else 120
    hits = scan(pid, marker, time.time() + limit)
    print('[+] 命中 %d 处' % len(hits))
    printed = set()
    for va, typ, d, i in hits:
        kind = 'IMAGE' if typ == IMAGE else 'HEAP'
        # 从 marker 开始往后取一大段，直到遇到明显的终止
        seg = d[i:i + 6000]
        # 取第一段「像 JSON/配置」的连续可打印内容
        m = re.match(rb'[\x20-\x7e]+', seg)
        if not m:
            continue
        text = m.group(0).decode('utf-8', 'replace')
        if text in printed:
            continue
        printed.add(text)
        print('\n============ VA 0x%x  %s  len=%d ============' % (va, kind, len(text)))
        print(text[:5000])
