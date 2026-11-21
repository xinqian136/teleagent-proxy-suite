#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
probe-authstate3.py — 解密内核 AuthState（用扫内存拿到的 SUPER_AGENT_* 环境变量）。

AuthState 结构 {version, iv, tag, ciphertext}。
内核 tool.DecryptAuthState 用的 key 就是 SUPER_AGENT_LOCAL_SESSION_KEY。

用法: probe-authstate3.py [pid]
"""
import os
import sys
import re
import json
import base64
import hashlib
import ctypes
import time

k32 = ctypes.windll.kernel32
PQI, PVM = 0x0400, 0x0010
MEM_COMMIT = 0x1000
READABLE = {0x02, 0x04, 0x20, 0x40, 0x80}

HERE = os.path.dirname(os.path.abspath(__file__))


class MBI(ctypes.Structure):
    _fields_ = [("BaseAddress", ctypes.c_ulonglong), ("AllocationBase", ctypes.c_ulonglong),
                ("AllocationProtect", ctypes.c_ulong), ("RegionSize", ctypes.c_ulonglong),
                ("State", ctypes.c_ulong), ("Protect", ctypes.c_ulong), ("Type", ctypes.c_ulong)]


def find_kernel_pid():
    import subprocess
    try:
        out = subprocess.run('netstat -ano | findstr :4397', shell=True,
                             capture_output=True, text=True, encoding='utf-8', errors='replace').stdout
    except Exception:
        return None
    for line in out.splitlines():
        if 'LISTENING' in line:
            p = line.split()
            if p:
                try:
                    return int(p[-1])
                except ValueError:
                    pass
    return None


def scan_env(pid, deadline):
    """扫内存找 "SUPER_AGENT_AUTH_STATE":"{...}" 这一段"""
    h = k32.OpenProcess(PQI | PVM, False, pid)
    if not h:
        print('OpenProcess failed'); return None
    addr = 0
    mbi = MBI()
    buf = ctypes.create_string_buffer(1 << 21)
    nr = ctypes.c_size_t(0)
    found = None
    while addr < 0x7FFFFFFFFFFF and not found:
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
                    i = d.find(b'"SUPER_AGENT_AUTH_STATE":"')
                    if i >= 0:
                        # 从值起点往后找：JSON 字符串值以未转义的 " 结束，
                        # 后面必须跟 , 或 } 或 空白。用「下一个 key":」定位更稳
                        seg = d[i + 26: i + 26 + 8000]
                        # 找形如 ,"XXX": 的下一个键名边界
                        end = len(seg)
                        m2 = re.search(rb'",(?:"[A-Za-z_][A-Za-z0-9_]*":)', seg)
                        if m2:
                            end = m2.start()
                        raw = seg[:end].replace(b'\\"', b'"')
                        try:
                            found = json.loads(raw.decode('utf-8'))
                            print('[+] 找到 AuthState（%d 字节密文）' % len(raw))
                        except Exception as e:
                            print('JSON 解析失败:', e, 'raw 前80:', raw[:80])
                        break
                off += chunk
            if found:
                break
        addr = mbi.BaseAddress + size
    k32.CloseHandle(h)
    return found


def scan_session_key(pid, deadline):
    """扫内存找 SUPER_AGENT_LOCAL_SESSION_KEY":"..."""
    h = k32.OpenProcess(PQI | PVM, False, pid)
    if not h:
        return None
    addr = 0
    mbi = MBI()
    buf = ctypes.create_string_buffer(1 << 21)
    nr = ctypes.c_size_t(0)
    found = None
    while addr < 0x7FFFFFFFFFFF and not found:
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
                    m = re.search(rb'"SUPER_AGENT_LOCAL_SESSION_KEY":"([A-Za-z0-9_-]{40,50})"', d)
                    if m:
                        found = m.group(1).decode('ascii')
                        print('[+] 找到 sessionKey')
                        break
                off += chunk
            if found:
                break
        addr = mbi.BaseAddress + size
    k32.CloseHandle(h)
    return found


def gcm_decrypt(key, iv, ct, tag):
    bcrypt = ctypes.windll.bcrypt

    class AUTH_INFO(ctypes.Structure):
        _fields_ = [
            ('cbSize', ctypes.c_ulong),
            ('pbNonce', ctypes.c_void_p), ('cbNonce', ctypes.c_ulong),
            ('pbAuthData', ctypes.c_void_p), ('cbAuthData', ctypes.c_ulong),
            ('pbTag', ctypes.c_void_p), ('cbTag', ctypes.c_ulong),
            ('pbMacContext', ctypes.c_void_p), ('cbMacContext', ctypes.c_ulong),
            ('cbAAD', ctypes.c_ulong), ('cbData', ctypes.c_ulong),
            ('dwFlags', ctypes.c_ulong),
        ]

    algo = ctypes.create_unicode_buffer('AES')
    h = ctypes.c_void_p()
    if bcrypt.BCryptOpenAlgorithmProvider(ctypes.byref(h), ctypes.cast(algo, ctypes.c_wchar_p), None, 0) != 0:
        raise OSError('open')
    obj_len = ctypes.c_ulong(0)
    bcrypt.BCryptGetProperty(ctypes.c_void_p(h), ctypes.c_wchar_p('ObjectLength'),
                             ctypes.byref(obj_len), ctypes.sizeof(obj_len), None, 0)
    obj = ctypes.create_string_buffer(obj_len.value)
    bcrypt.BCryptGetProperty(ctypes.c_void_p(h), ctypes.c_wchar_p('ObjectLength'),
                             obj, obj_len.value, ctypes.byref(obj_len), 0)
    hkey = ctypes.c_void_p()
    if bcrypt.BCryptGenerateSymmetricKey(ctypes.c_void_p(h), ctypes.byref(hkey), obj,
                                         obj_len.value, key, len(key), 0) != 0:
        raise OSError('genkey')
    mode = ctypes.create_unicode_buffer('ChainingModeGCM')
    bcrypt.BCryptSetProperty(ctypes.c_void_p(hkey), ctypes.c_wchar_p('ChainingMode'),
                             ctypes.cast(mode, ctypes.c_wchar_p), (len('ChainingModeGCM') + 1) * 2, 0)
    tl = ctypes.c_ulong(16)
    bcrypt.BCryptSetProperty(ctypes.c_void_p(hkey), ctypes.c_wchar_p('AuthTagLength'),
                             ctypes.byref(tl), ctypes.sizeof(tl), 0)

    nb = ctypes.create_string_buffer(iv, len(iv))
    tb = ctypes.create_string_buffer(tag, len(tag))
    info = AUTH_INFO()
    info.cbSize = ctypes.sizeof(info)
    info.pbNonce = ctypes.cast(nb, ctypes.c_void_p)
    info.cbNonce = len(iv)
    info.pbTag = ctypes.cast(tb, ctypes.c_void_p)
    info.cbTag = len(tag)

    out = ctypes.create_string_buffer(max(len(ct), 32))
    outlen = ctypes.c_ulong(0)
    if bcrypt.BCryptDecrypt(ctypes.c_void_p(hkey), ct, len(ct), ctypes.byref(info),
                             None, 0, out, ctypes.sizeof(out), ctypes.byref(outlen), 0) != 0:
        raise OSError('decrypt')
    return out.raw[:outlen.value]


def main():
    print('=== AuthState 解密（扫内存版）===\n')
    pid = int(sys.argv[1]) if len(sys.argv) > 1 else find_kernel_pid()
    print('内核 PID:', pid)
    deadline = time.time() + 150

    sk = scan_session_key(pid, deadline)
    payload = scan_env(pid, deadline)
    if not payload:
        print('没找到 AuthState'); return
    print('AuthState 字段:', ', '.join(payload.keys()))

    iv = base64.urlsafe_b64decode(payload['iv'] + '=' * (-len(payload['iv']) % 4))
    _ct = payload['ciphertext']
    _tag = payload['tag']
    ct = base64.urlsafe_b64decode(_ct + '=' * (-len(_ct) % 4))
    tag = base64.urlsafe_b64decode(_tag + '=' * (-len(_tag) % 4))
    print('iv %d / ct %d / tag %d 字节' % (len(iv), len(ct), len(tag)))
    print()

    keys = []
    if sk:
        raw = base64.urlsafe_b64decode(sk + '=' * (-len(sk) % 4))
        keys.append(('sessionKey raw', raw))
        keys.append(('sha256(sk raw)', hashlib.sha256(raw).digest()))
        keys.append(('sha256(sk utf8)', hashlib.sha256(sk.encode()).digest()))
        keys.append(('sha256(sk b64str)', hashlib.sha256(sk.encode()).digest()))
        keys.append(('md5(sk raw)*2', hashlib.md5(raw).digest() * 2))
        keys.append(('hkdf-ish: sha256(sk||"auth")', hashlib.sha256(raw + b'auth').digest()))
        keys.append(('hkdf-ish: sha256("auth"||sk)', hashlib.sha256(b'auth' + raw).digest()))
        keys.append(('sha256(sk raw+"\\x00")', hashlib.sha256(raw + b'\x00').digest()))
        # HMAC 派生
        import hmac as _h
        keys.append(('hmac(sk_raw,"auth")', _h.new(raw, b'auth', hashlib.sha256).digest()))
        keys.append(('hmac(sk_raw,"superagent")', _h.new(raw, b'superagent', hashlib.sha256).digest()))
        keys.append(('hmac(sk_utf8,"auth")', _h.new(sk.encode(), b'auth', hashlib.sha256).digest()))
    else:
        kf = os.path.join(HERE, '..', 'scripts', 'session.key')
        if os.path.exists(kf):
            s = open(kf, encoding='utf-8').strip()
            keys.append(('file sessionKey raw', base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))))

    ivs = [
        ('iv 原样', iv),
        ('md5(iv str)[:16]', hashlib.md5(payload['iv'].encode()).digest()[:16]),
        ('sha256(iv str)[:16]', hashlib.sha256(payload['iv'].encode()).digest()[:16]),
        ('md5(iv raw)[:16]', hashlib.md5(iv).digest()[:16]),
    ]

    for kn, k in keys:
        for inn, ivv in ivs:
            try:
                pt = gcm_decrypt(k, ivv, ct, tag)
                print('✓ 解密成功 [%s | %s]' % (kn, inn))
                try:
                    print(json.dumps(json.loads(pt.decode('utf-8')), ensure_ascii=False, indent=1)[:2000])
                except Exception:
                    print(pt[:1200])
                return
            except Exception:
                pass
    print('所有组合都失败')


if __name__ == '__main__':
    main()
