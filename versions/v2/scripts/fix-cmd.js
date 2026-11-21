#!/usr/bin/env node
/**
 * fix-cmd.js — 把 .cmd 脚本规范成 CRLF
 *
 * 只做换行转换，**不做任何内容替换**。
 * （之前用正则删 pause 时，`\s*` 吃掉了换行符，把后面的
 *   exit /b 1、endlocal 全并进了 echo 行，脚本直接报废。）
 *
 * 用法: node scripts/fix-cmd.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CMD_FILES = ['启动.cmd', '导出账号.cmd', '导入账号.cmd', '检查状态.cmd',
  'scripts/start.cmd', 'scripts/install-task.cmd'];

for (const rel of CMD_FILES) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  const buf = fs.readFileSync(p);
  // 只做字节级换行转换，别的什么都不动
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      if (i === 0 || buf[i - 1] !== 0x0d) out.push(0x0d);   // 补 CR
      out.push(0x0a);
    } else {
      out.push(buf[i]);
    }
  }
  fs.writeFileSync(p, Buffer.from(out));
  console.log(`  ${rel}  ${out.length} 字节`);
}
console.log('完成。');
