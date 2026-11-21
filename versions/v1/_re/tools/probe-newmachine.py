#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
probe-newmachine.py — 实验：新机器上扫描账号的可行性边界。

模拟一台新机器（只复制了 TeleAgent 数据目录，没有本机 DPAPI 绑定），
分别测试 safe_storage 与 local 两种加密方案能否解开。

用法:
  "<python>" probe-newmachine.py [模拟HOME目录]
"""
import base64
import ctypes
import json
import os
import sys

HOME = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('USERPROFILE')
DATA = os.path.join(HOME, '.local', 'share', 'TeleAgent')


class DATA_BLOB(ctypes.Structure):
    _fields_ = [('cbData', ctypes.c_uint), ('pbData', ctypes.POINTER(ctypes.c_char))]


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


def get_dpapi_key():
    """从 Local State 取 DPAPI 保护的 AES key"""
    ls_path = os.path.join(DATA, 'Local State')
    if not os.path.exists(ls_path):
        return None, 'no Local State'
    ls = json.load(open(ls_path, encoding='utf-8'))
    ek = ls.get('os_crypt', {}).get('encrypted_key')
    if not ek:
        return None, 'no encrypted_key'
    raw = base64.b64decode(ek)
    if raw[:5] == b'DPAPI':
        raw = raw[5:]
    try:
        key = dpapi_unprotect(raw)
    except Exception as e:
        return None, 'DPAPI failed: %s' % e
    if len(key) != 32:
        return None, 'key len %d != 32' % len(key)
    return key, 'ok'


def aes_gcm_decrypt(b64, key, prefix=0):
    """prefix=3 是 safe_storage(v10|nonce12|ct|tag16)；prefix=0 是 local(nonce12|ct|tag16)"""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    b = base64.b64decode(b64)
    if prefix:
        assert b[:prefix] == b'v10', b[:prefix]
    nonce = b[prefix:prefix + 12]
    ct = b[prefix + 12:len(b) - 16]
    tag = b[len(b) - 16:]
    return AESGCM(key).decrypt(nonce, ct + tag, None)


def main():
    print('=== 模拟新机器扫描 ===')
    print('HOME :', HOME)
    print('DATA :', DATA)
    print()

    if not os.path.exists(DATA):
        print('[结论] 该机器无 TeleAgent 数据目录 → 扫不到账号')
        return

    users = os.path.join(DATA, 'users')
    if not os.path.exists(users):
        print('[结论] 无 users 目录 → 未登录过，无账号')
        return

    accts = [d for d in os.listdir(users) if d.startswith('v1_public_')]
    print('[扫描] users/ 下找到账号目录:', len(accts))
    for a in accts:
        print('   ', a)

    aes_key, why = get_dpapi_key()
    print()
    print('[DPAPI] Local State 解密:', why)
    if aes_key:
        print('        AES key =', aes_key.hex())

    print()
    for d in accts:
        tj_path = os.path.join(users, d, 'app-auth', 'token.json')
        if not os.path.exists(tj_path):
            print(' ', d, '-> 无 token.json')
            continue
        tj = json.load(open(tj_path, encoding='utf-8'))
        scheme = tj.get('scheme')
        print(' ', d, 'scheme=%s' % scheme)

        if scheme == 'local':
            lk = os.path.join(users, d, 'app-auth', 'local-key')
            if not os.path.exists(lk):
                print('      ✗ 无 local-key')
                continue
            key = open(lk, 'rb').read()
            try:
                tok = aes_gcm_decrypt(tj['encryptedToken'], key, 0).decode('utf-8')
                print('      ✓ local 方案解密成功 → token 长度', len(tok))
            except Exception as e:
                print('      ✗ local 解密失败:', e)
            continue

        if not aes_key:
            print('      ✗ 无法解密（safe_storage 需要本机 DPAPI）')
            continue
        try:
            tok = aes_gcm_decrypt(tj['encryptedToken'], aes_key, 3).decode('utf-8')
            import json as _j
            payload = tok.split(':')[1]
            pl = _j.loads(base64.urlsafe_b64decode(payload.split('.')[1] + '=='))
            print('      ✓ safe_storage 解密成功 →', pl.get('accountName'))
        except Exception as e:
            print('      ✗ safe_storage 解密失败:', e)


if __name__ == '__main__':
    main()
