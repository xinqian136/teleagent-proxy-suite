#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
wire-headers2.py — 扫内核内存，区分「二进制常量池里的」和「运行时才有的」字符串。

内核把 exe 映射进内存，.rdata 的常量池会被扫到 → 噪音大。
做法：先扫 exe 文件里的字符串集合，再扫内存，
只报**内存里有、exe 里没有**的字符串 —— 那才是运行时生成的（真实请求头/值）。

用法: wire-headers2.py <kernel_pid> <exe_path>
"""
import ctypes, re, sys, os

k32 = ctypes.windll.kernel32
PQI, PVM = 0x0400, 0x0010
MEM_COMMIT = 0x1000
READABLE = {0x02, 0x04, 0x20, 0x40, 0x80}

# 候选：像 HTTP 头名的 token
CAND = re.compile(rb'(?<![A-Za-z0-9_-])([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+){1,6})(?![A-Za-z0-9_-])')
# 只保留看起来像头的（含 Super/Agent/Teleai/Superagent/Token/Sign/Auth/Version/Timestamp/Nonce/Device/Install/Request/Session/Message 等）
KEEP = re.compile(rb'(?i)^(x-[a-z].*|authorization|user-agent|content-type|accept|.*super.*|.*teleai.*|.*token.*|.*sign.*|.*auth.*|.*version.*|.*timestamp.*|.*nonce.*|.*device.*|.*install.*|.*session.*|.*message.*|.*machine.*|.*route.*|.*gateway.*)$')


class MBI(ctypes.Structure):
    _fields_ = [("BaseAddress", ctypes.c_ulonglong), ("AllocationBase", ctypes.c_ulonglong),
                ("AllocationProtect", ctypes.c_ulong), ("RegionSize", ctypes.c_ulonglong),
                ("State", ctypes.c_ulong), ("Protect", ctypes.c_ulong), ("Type", ctypes.c_ulong)]


def exe_strings(path):
    """exe 里的可打印字符串集合（长度 >= 4）"""
    data = open(path, 'rb').read()
    out = set()
    for m in re.finditer(rb'[\x20-\x7e]{4,200}', data):
        out.add(m.group(0))
    return out


def scan_mem(pid, keep_re, deadline=None, skip_image=True):
    h = k32.OpenProcess(PQI | PVM, False, pid)
    if not h:
        print('OpenProcess failed err=%d' % k32.GetLastError()); return {}
    addr = 0; mbi = MBI()
    buf = ctypes.create_string_buffer(1 << 21); nr = ctypes.c_size_t(0)
    found = {}
    import time
    t0 = time.time()
    while addr < 0x7FFFFFFFFFFF:
        if deadline and time.time() > deadline:
            print('[!] 超时，停止扫描（已扫 %d 个）' % len(found))
            break
        if not k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)):
            break
        size = mbi.RegionSize
        # 跳过映像段（exe 映射进来的只读区），噪音大且量大
        img = skip_image and (mbi.Protect & 0x100)  # PAGE_GUARD 无关；用 Type 判断
        if mbi.State == MEM_COMMIT and (mbi.Protect & 0xFF) in READABLE and 0 < size < (1 << 30):
            off = 0
            while off < size:
                chunk = min(len(buf), size - off)
                if k32.ReadProcessMemory(h, ctypes.c_void_p(mbi.BaseAddress + off), buf, chunk, ctypes.byref(nr)):
                    d = buf.raw[:nr.value]
                    for m in CAND.finditer(d):
                        s = m.group(1)
                        if len(s) < 4 or len(s) > 60:
                            continue
                        if not keep_re.match(s):
                            continue
                        found.setdefault(s, m.start())
                off += chunk
            addr = mbi.BaseAddress + size
        else:
            addr = mbi.BaseAddress + size
    k32.CloseHandle(h)
    return found


if __name__ == '__main__':
    import time
    pid = int(sys.argv[1]); exep = sys.argv[2]
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else 180
    exes = exe_strings(exep)
    print('[+] exe 字符串集合: %d' % len(exes), flush=True)
    mem = scan_mem(pid, KEEP, deadline=time.time() + limit)
    print('[+] 内存中候选: %d' % len(mem), flush=True)
    only_mem = []
    for s, off in sorted(mem.items()):
        # 检查它是否作为独立 token 出现在 exe 中
        if s not in exes:
            # 宽松检查：exe 里是否有包含它的更长串
            if not any(s in e for e in exes):
                only_mem.append(s)
    print('\n=== 只在内存里（运行时生成）===')
    for s in only_mem:
        print('   ', s.decode('ascii', 'replace'))
