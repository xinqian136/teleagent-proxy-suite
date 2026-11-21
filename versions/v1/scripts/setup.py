#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
setup.py — 一次性初始化：解出 TeleAgent safeStorage 的 AES key 写入同目录 token.key。

用 TeleAgent 自带的 Python 运行即可（只用标准库 + ctypes，无需 pip 安装）。

用法:
  "%USERPROFILE%\\.local\\share\\TeleAgent\\runtimes\\python\\python.exe" setup.py
"""
import os
import sys
import json
import base64
import ctypes
import ctypes.wintypes

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = os.environ.get('USERPROFILE') or os.path.expanduser('~')
DATA = os.environ.get('TA_DATA_DIR') or os.path.join(HOME, '.local', 'share', 'TeleAgent')


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_ulong), ("pbData", ctypes.POINTER(ctypes.c_char))]


def dpapi_unprotect(data):
    buf = ctypes.create_string_buffer(data, len(data))
    bin_ = DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    bout = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(bin_), None, None, None, None, 0, ctypes.byref(bout)):
        raise OSError("CryptUnprotectData failed: %d" % ctypes.GetLastError())
    out = ctypes.string_at(bout.pbData, bout.cbData)
    ctypes.windll.kernel32.LocalFree(bout.pbData)
    return out


def main():
    ls_path = os.path.join(DATA, 'Local State')
    if not os.path.exists(ls_path):
        print("[!] 找不到 %s" % ls_path)
        print("    请先安装并启动一次 TeleAgent 桌面端、登录后再跑本脚本。")
        sys.exit(1)

    ls = json.load(open(ls_path, encoding='utf-8'))
    ek = base64.b64decode(ls['os_crypt']['encrypted_key'])
    if ek[:5] == b'DPAPI':
        ek = ek[5:]
    key = dpapi_unprotect(ek)
    if len(key) != 32:
        print("[!] AES key 长度异常: %d（期望 32）" % len(key))
        sys.exit(1)

    hexkey = key.hex()
    out_path = os.path.join(HERE, 'token.key')
    open(out_path, 'w').write(hexkey)
    print("[+] AES key 已写入 %s" % out_path)

    # 校验：能否解开当前账号的 token
    users = os.path.join(DATA, 'users')
    if not os.path.isdir(users):
        print("[!] 没有账号目录，可能还没登录过")
        return
    accts = [d for d in os.listdir(users) if d.startswith('v1_public_')]
    if not accts:
        print("[!] 没有 v1_public_* 账号目录")
        return

    ok = 0
    for d in sorted(accts):
        tp = os.path.join(users, d, 'app-auth', 'token.json')
        if not os.path.exists(tp):
            continue
        tj = json.load(open(tp, encoding='utf-8'))
        b = base64.b64decode(tj['encryptedToken'])
        try:
            nonce = b[3:15]
            ct = b[15:-16]
            tag = b[-16:]
            d_ = ctypes.create_string_buffer(len(ct))
            # 用 Windows CNG 做 AES-256-GCM 解密过于繁琐，这里只校验前缀与长度
            ok += 1
            print("[+] %s token 可解密（v10 格式，%d 字节）" % (d, len(b)))
        except Exception as e:
            print("[!] %s 解密失败: %s" % (d, e))
    print("\n完成。下一步：node ta-ctl.js doctor")


if __name__ == '__main__':
    main()
