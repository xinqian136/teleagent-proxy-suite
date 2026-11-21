#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
find-sessionkey.py — 找到并校验 TeleAgent 本地内核的 sessionKey。

3.0.1 起 secret 走 stdin 传给 Go 内核，进程环境块里没有了。
但 Electron 主进程 JS 堆里 LocalAuthService.sessionKey 是一个
43 字符 base64url 字符串（randomBytes(32).toString('base64url')）。

流程：
  1. 只扫 TeleAgent 相关进程（Electron 主/渲染 + node 子进程 + Go 内核）
  2. 收集所有「43 字符 base64url 且解码后正好 32 字节」的字符串作为候选
  3. 逐个候选按 local-v1 协议签名调内核 /provider，200 即命中
     —— 端到端校验，零误判

输出：stdout 打印 sessionKey=<43字符>，同时写同目录 session.key
"""
import ctypes, re, sys, os, base64, time, json, urllib.request, urllib.error
from ctypes import wintypes

k32 = ctypes.windll.kernel32
PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
READABLE = {0x02, 0x04, 0x20, 0x40, 0x80}
TH32CS_SNAPPROCESS = 0x00000002

HERE = os.path.dirname(os.path.abspath(__file__))
KERNEL = os.environ.get('TA_KERNEL_URL', 'http://127.0.0.1:4397')

CAND = re.compile(rb'(?<![A-Za-z0-9_\-])[A-Za-z0-9_\-]{43}(?![A-Za-z0-9_\-])')


class MBI(ctypes.Structure):
    _fields_ = [("BaseAddress", ctypes.c_ulonglong), ("AllocationBase", ctypes.c_ulonglong),
                ("AllocationProtect", ctypes.c_ulong), ("RegionSize", ctypes.c_ulonglong),
                ("State", ctypes.c_ulong), ("Protect", ctypes.c_ulong), ("Type", ctypes.c_ulong)]


class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
                ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_char * 260)]


def list_pids():
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == -1:
        return []
    pe = PROCESSENTRY32(); pe.dwSize = ctypes.sizeof(pe)
    out = []
    ok = k32.Process32First(snap, ctypes.byref(pe))
    while ok:
        out.append((pe.th32ProcessID, pe.szExeFile.decode('ascii', 'ignore')))
        ok = k32.Process32Next(snap, ctypes.byref(pe))
    k32.CloseHandle(snap)
    return out


def is_b64_32(s):
    if len(s) != 43:
        return False
    try:
        raw = base64.urlsafe_b64decode(s + '=')
    except Exception:
        return False
    return len(raw) == 32


def scan_pid(pid, cands, budget=400 << 20):
    h = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        return
    addr = 0
    mbi = MBI()
    buf = ctypes.create_string_buffer(1 << 20)
    nread = ctypes.c_size_t(0)
    total = 0
    try:
        while addr < 0x7FFFFFFFFFFF and total < budget:
            if not k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)):
                break
            size = mbi.RegionSize
            if mbi.State == MEM_COMMIT and (mbi.Protect & 0xFF) in READABLE and 0 < size < (1 << 30):
                off = 0
                while off < size:
                    chunk = min(len(buf), size - off)
                    if k32.ReadProcessMemory(h, ctypes.c_void_p(mbi.BaseAddress + off), buf, chunk, ctypes.byref(nread)):
                        data = buf.raw[:nread.value]
                        total += len(data)
                        for m in CAND.finditer(data):
                            s = m.group(0).decode('ascii', 'ignore')
                            if is_b64_32(s):
                                cands.add(s)
                    off += chunk
            addr = mbi.BaseAddress + size
    finally:
        k32.CloseHandle(h)


def sign_headers(key, method, path):
    import hmac, hashlib
    ts = str(int(time.time() * 1000))
    nonce = os.urandom(12).hex()
    payload = "\n".join(["local-v1", method.upper(), path, ts, nonce])
    sig = hmac.new(key.encode(), payload.encode(), hashlib.sha256).digest()
    return {
        "X-SA-Sign-Version": "local-v1",
        "X-SA-Timestamp": ts,
        "X-SA-Nonce": nonce,
        "X-SA-Signature": base64.urlsafe_b64encode(sig).decode().rstrip('='),
    }


def try_key(key):
    try:
        req = urllib.request.Request(KERNEL + "/provider", headers=sign_headers(key, 'GET', '/provider'), method='GET')
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return None


def main():
    all_p = list_pids()
    cand_pids = [(p, n) for p, n in all_p if 'teleagent' in n.lower() or n.lower() in ('node.exe',)]
    sys.stderr.write("[*] 目标进程: %s\n" % ", ".join("%s(%d)" % (n, p) for p, n in cand_pids))
    if not cand_pids:
        sys.stderr.write("[!] 没找到 TeleAgent 进程，请先打开并登录 TeleAgent\n")
        return 1

    cands = set()
    for pid, name in cand_pids:
        t0 = time.time()
        scan_pid(pid, cands)
        sys.stderr.write("    扫 %s(%d) 完成，累计候选 %d (%.1fs)\n" % (name, pid, len(cands), time.time() - t0))

    sys.stderr.write("[*] %d 个候选，逐个端到端校验...\n" % len(cands))
    for i, k in enumerate(sorted(cands)):
        if try_key(k) == 200:
            with open(os.path.join(HERE, 'session.key'), 'w') as f:
                f.write(k)
            print("sessionKey=%s" % k)
            sys.stderr.write("[+] 命中，已写 session.key\n")
            return 0
        if i % 100 == 0:
            sys.stderr.write("    [%d/%d]\n" % (i, len(cands)))
    sys.stderr.write("[!] %d 个候选全部未通过\n" % len(cands))
    return 1


if __name__ == '__main__':
    sys.exit(main())
