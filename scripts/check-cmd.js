#!/usr/bin/env node
/**
 * check-cmd.js — 校验 .cmd 脚本
 *
 * cmd.exe 按 ANSI/GBK 读取脚本文件，所以：
 *   1. 必须用 CRLF 换行（LF 会导致命令被拆散）
 *   2. 必须是纯 ASCII（中文注释会让解析错乱）
 *
 * 这个检查挂进提交前流程，避免再次踩坑。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CMD_FILES = ['启动.cmd', '导出账号.cmd', '导入账号.cmd', '检查状态.cmd',
  'scripts/start.cmd', 'scripts/install-task.cmd'];

let bad = 0;
for (const rel of CMD_FILES) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { console.log(`  ? ${rel}  (不存在)`); continue; }
  const buf = fs.readFileSync(p);
  const s = buf.toString('latin1');

  const nonAscii = [...s].filter((c) => c.charCodeAt(0) > 127).length;
  const lfOnly = (s.match(/(?<!\r)\n/g) || []).length;

  const problems = [];
  if (nonAscii) problems.push(`${nonAscii} 个非 ASCII 字符`);
  if (lfOnly) problems.push(`${lfOnly} 个 LF-only 换行`);

  if (problems.length) {
    console.log(`  \x1b[31m✗\x1b[0m ${rel}  ${problems.join('，')}`);
    bad++;
  } else {
    console.log(`  \x1b[32m✓\x1b[0m ${rel}  CRLF + 纯 ASCII`);
  }
}

if (bad) {
  console.log('\n修复方法：用 Write 工具重写为纯 ASCII 内容，然后运行');
  console.log('  node scripts/fix-cmd.js');
  process.exit(1);
}
console.log('\n全部 cmd 脚本正常。');
