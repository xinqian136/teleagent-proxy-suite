#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""提交前敏感信息终检：扫描将要提交的文件，确保没有凭据泄漏。"""
import os
import re
import subprocess
import sys

REPO = r'C:\Users\Administrator\WorkBuddy\2026-11-18-10-35-09\teleagent-proxy'

# 敏感模式
PATTERNS = [
    (r'sk-[A-Za-z0-9]{20,32}', '渠道密钥 sk-'),
    (r'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}', 'JWT token'),
    (r'\bBearer\s+[A-Za-z0-9._\-]{20,}', 'Bearer 凭证'),
    (r'pt_[A-Za-z0-9]{16,}', 'platform token pt_'),
    (r'[0-9a-f]{64}', '64位hex（可能是AES key）'),
    (r'[A-Za-z0-9_-]{43}', '43字符base64url（可能是sessionKey）'),
    (r'(?i)(password|passwd|pwd)\s*[:=]\s*["\'][^"\']{4,}', '明文口令'),
]

# 允许出现的位置（文档里举例说明）
ALLOW_FILES = {'.gitignore'}

files = subprocess.run(
    ['git', 'ls-files', '--cached', '--others', '--exclude-standard'],
    cwd=REPO, capture_output=True, text=True, encoding='utf-8'
).stdout.splitlines()

print('待检查文件数: %d\n' % len(files))

issues = []
for rel in files:
    fp = os.path.join(REPO, rel.replace('/', os.sep))
    if not os.path.isfile(fp):
        continue
    if rel in ALLOW_FILES:
        continue
    try:
        data = open(fp, 'rb').read()
    except OSError:
        continue
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        text = data.decode('latin1')

    for pat, label in PATTERNS:
        for m in re.finditer(pat, text):
            val = m.group(0)
            # 过滤明显是示例/占位的
            if val.startswith('sk-<'):
                continue
            line_no = text[:m.start()].count('\n') + 1
            issues.append((rel, line_no, label, val[:70]))

if not issues:
    print('[✓] 未发现敏感信息')
    sys.exit(0)

print('[!] 发现 %d 处疑似敏感内容：\n' % len(issues))
for rel, ln, label, val in issues:
    print('  %-28s :%-5d %-22s %s' % (rel, ln, label, val))
sys.exit(1)
