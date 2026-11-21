#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
dump-region.py — dump 二进制里某关键字周边的大块内容，用于还原算法。

用法: dump-region.py <file> <keyword> [before] [after]
"""
import sys, os, re

path, kw = sys.argv[1], sys.argv[2].encode('utf-8')
before = int(sys.argv[3]) if len(sys.argv) > 3 else 2000
after = int(sys.argv[4]) if len(sys.argv) > 4 else 4000

size = os.path.getsize(path)
CH = 8 << 20
with open(path, 'rb') as f:
    pos = 0
    prev = b''
    hit = 0
    while True:
        chunk = f.read(CH)
        if not chunk:
            break
        data = prev + chunk
        i = data.find(kw)
        if i >= 0:
            s = max(0, i - before)
            e = min(len(data), i + len(kw) + after)
            txt = data[s:e].decode('utf-8', 'replace')
            txt = re.sub(r'[\x00-\x08\x0b-\x1f\x7f-\xff]', '.', txt)
            print("=== HIT @%d ===" % (pos + i))
            print(txt)
            hit += 1
            if hit >= 3:
                break
        prev = data[-4096:] if len(data) >= 4096 else data
        pos += len(chunk)
    if not hit:
        print("no hit")
