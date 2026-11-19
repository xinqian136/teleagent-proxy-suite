#!/usr/bin/env node
/**
 * fix-cmd.js — 把 .cmd 脚本规范成 CRLF
 *
 * 只做字节级换行转换，别的什么都不动。
 * （曾用正则删 pause，`\s*` 吃掉换行符把脚本搞坏了。）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CMD_FILES = ['启动后台.cmd', '暂停后台.cmd', 'scripts/install-task.cmd'];

for (const rel of CMD_FILES) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  const buf = fs.readFileSync(p);
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      if (i === 0 || buf[i - 1] !== 0x0d) out.push(0x0d);
      out.push(0x0a);
    } else out.push(buf[i]);
  }
  fs.writeFileSync(p, Buffer.from(out));
  console.log(`  ${rel}  ${out.length} bytes`);
}
console.log('done');
