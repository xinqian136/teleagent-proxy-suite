#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
strings-scan.py — 在大二进制里搜关键词并打印上下文，用于摸清 3.0.1 的鉴权实现。

用法: strings-scan.py <file> <kw1> [kw2 ...]
"""
import sys, os, re


def scan(path, kws, ctx=260, maxhits=8):
    kws_b = [k.encode('utf-8') for k in kws]
    found = {k: 0 for k in kws}
    CH = 8 << 20
    overlap = 1024
    with open(path, 'rb') as f:
        pos = 0
        prev = b''
        while True:
            chunk = f.read(CH)
            if not chunk:
                break
            data = prev + chunk
            for k, kb in zip(kws, kws_b):
                if found[k] >= maxhits:
                    continue
                for pat in (kb, k.encode('utf-16-le')):
                    start = 0
                    while found[k] < maxhits:
                        i = data.find(pat, start)
                        if i < 0:
                            break
                        s = max(0, i - ctx)
                        e = min(len(data), i + len(pat) + ctx)
                        txt = data[s:e].decode('utf-8', 'replace')
                        txt = re.sub(r'[\x00-\x08\x0b-\x1f\x7f-\xff]', '.', txt)
                        print("---- [%s] @%d ----" % (k, pos + i))
                        print(txt)
                        found[k] += 1
                        start = i + len(pat)
            prev = data[-overlap:] if len(data) >= overlap else data
            pos += len(chunk)


if __name__ == '__main__':
    path = sys.argv[1]
    print("=== scanning %s (%.1f MB) ===" % (path, os.path.getsize(path) / 1048576))
    scan(path, sys.argv[2:])
