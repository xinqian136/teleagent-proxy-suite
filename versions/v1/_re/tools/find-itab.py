#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
find-itab.py — 在进程内存里找某个 Go itab 实例，并追踪谁引用它。

itab 结构： { inter *InterfaceType, _type *_type, hash uint32, fun []func() }
fun[0] 位于 itab+24。给定 fun[0] 的目标地址，可在内存里搜到 itab 实例。

用法: find-itab.py <pid> <fun0_addr_hex>
"""
import ctypes, re, sys, os, struct, time

k32 = ctypes.windll.kernel32
PQI, PVM = 0x0400, 0x0010
MEM_COMMIT = 0x1000
READABLE = {0x02, 0x04, 0x20, 0x40, 0x80}
IMAGE = 0x1000000   # MEM_IMAGE


class MBI(ctypes.Structure):
    _fields_ = [("BaseAddress", ctypes.c_ulonglong), ("AllocationBase", ctypes.c_ulonglong),
                ("AllocationProtect", ctypes.c_ulong), ("RegionSize", ctypes.c_ulonglong),
                ("State", ctypes.c_ulong), ("Protect", ctypes.c_ulong), ("Type", ctypes.c_ulong)]


def scan(pid, needle, deadline, collect_all=False):
    """needle: 8字节小端。返回 [(所在区域VA, 匹配偏移)]"""
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
                        out.append((mbi.BaseAddress + off + i, mbi.Type, size))
                        i += 1
                off += chunk
            addr = mbi.BaseAddress + size
        else:
            addr = mbi.BaseAddress + size
    k32.CloseHandle(h)
    return out


if __name__ == '__main__':
    pid = int(sys.argv[1])
    fun0 = int(sys.argv[2], 16)
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else 120
    needle = struct.pack('<Q', fun0)
    print('[+] 搜 fun[0]=0x%x 的 itab 实例 ...' % fun0, flush=True)
    hits = scan(pid, needle, time.time() + limit)
    print('[+] 命中 %d 处' % len(hits))
    for va, typ, size in hits[:40]:
        kind = 'IMAGE(常量池)' if typ == IMAGE else 'HEAP'
        print('   VA 0x%x  %s' % (va, kind))
