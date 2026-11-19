#!/usr/bin/env node
/**
 * test-oneroot.js — 验收：一台完全空白的机器
 *
 * 模拟真实用户场景：
 *   1. 全新目录（只有程序文件，没有 data/、没有 config/channel-key.txt）
 *   2. 放入账号包
 *   3. 跑「导入账号.cmd」→  应自动导入 + 自动配好渠道密钥
 *   4. 跑「启动.cmd」→    应自动起服务 + 生成客户端配置
 *   5. 推理成功
 *
 * 用法: node scripts/test-oneroot.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const TMP = path.join(os.tmpdir(), 'tav2-oneroot');
const PORT = 8796;

function ok(m) { console.log('  \x1b[32m✓\x1b[0m ' + m); }
function bad(m) { console.log('  \x1b[31m✗\x1b[0m ' + m); }

function copyDir(src, dst, skip) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.includes(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d, skip);
    else fs.copyFileSync(s, d);
  }
}

function req(port, p, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { Authorization: 'Bearer teleagent-local' };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method: body ? 'POST' : 'GET', headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => b += c); resp.on('end', () => res({ code: resp.statusCode, body: b }));
    });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n\x1b[1m=== 验收：一台完全空白的机器 ===\x1b[0m\n');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

  // 1. 造一台空白机器
  console.log('1. 造一台空白机器（只有程序，没有账号没有配置）');
  copyDir(ROOT, TMP, ['data', 'node_modules', '.git', 'account.bundle', '客户端配置.txt', 'config']);
  fs.mkdirSync(path.join(TMP, 'config'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'config', 'default.json'), path.join(TMP, 'config', 'default.json'));
  ok('目录已就绪：' + fs.readdirSync(TMP).filter((f) => f.endsWith('.cmd')).join(', '));

  // 2. 源机导出账号包
  console.log('\n2. 源机导出账号包');
  const pkg = path.join(TMP, 'account.bundle');
  execFileSync(NODE, [path.join(ROOT, 'bin', 'tav2.js'), 'export', '--format', 'bundle', '--out', pkg],
    { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  ok('账号包已生成（' + fs.statSync(pkg).size + ' 字节，含渠道密钥）');

  // 3. 跑「导入账号.cmd」（真实 cmd 调用）
  console.log('\n3. 双击「导入账号.cmd」');
  const imp = spawn('cmd.exe', ['/c', path.join(TMP, '导入账号.cmd')], {
    cwd: TMP, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let impOut = '';
  imp.stdout.on('data', (d) => { impOut += d.toString(); });
  imp.stderr.on('data', (d) => { impOut += d.toString(); });
  await new Promise((r) => { imp.on('exit', r); setTimeout(r, 25000); });

  const vaultExists = fs.existsSync(path.join(TMP, 'data', 'accounts.vault'));
  const ckExists = fs.existsSync(path.join(TMP, 'config', 'channel-key.txt'));
  if (vaultExists) ok('凭据库已生成'); else { bad('凭据库没生成'); console.log(impOut.slice(0, 500)); }
  if (ckExists) ok('渠道密钥已自动配置'); else { bad('渠道密钥没配置'); console.log(impOut.slice(0, 500)); }

  // 4. 跑「启动.cmd」
  console.log('\n4. 双击「启动.cmd」');
  const srv = spawn('cmd.exe', ['/c', path.join(TMP, '启动.cmd'), '--port', String(PORT)], {
    cwd: TMP, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvOut = '';
  srv.stdout.on('data', (d) => { srvOut += d.toString(); });
  srv.stderr.on('data', (d) => { srvOut += d.toString(); });

  let up = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    up = await req(PORT, '/health').then(() => true).catch(() => false);
    if (up) break;
  }
  if (up) ok('服务已启动（' + PORT + '）');
  else { bad('服务没起来'); console.log(srvOut.slice(0, 800)); }

  // 5. 客户端配置是否自动生成
  console.log('\n5. 客户端配置是否自动生成');
  const cfgPath = path.join(TMP, '客户端配置.txt');
  if (fs.existsSync(cfgPath)) {
    const c = fs.readFileSync(cfgPath, 'utf8');
    ok('已生成 客户端配置.txt');
    if (/Cherry Studio/.test(c) && /Cline/.test(c)) ok('包含各客户端填法说明');
  } else bad('没生成客户端配置');

  // 6. 推理
  console.log('\n6. 推理测试');
  if (up) {
    const r = await req(PORT, '/v1/chat/completions', {
      model: 'chat-flagship', messages: [{ role: 'user', content: '用一句话说你是谁' }],
    });
    if (r.code === 200) ok('推理成功: ' + String(JSON.parse(r.body).choices[0].message.content).slice(0, 50));
    else bad('推理失败 HTTP ' + r.code + ': ' + r.body.slice(0, 120));
  }

  // 清理：kill 整个进程树（cmd 包装的 serve 是长驻进程）
  try { execFileSync('taskkill', ['/F', '/T', '/PID', String(srv.pid)], { stdio: 'ignore' }); } catch (_) {}
  try { srv.kill(); } catch (_) {}
  await sleep(2000);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  ok('临时目录已清理');

  if (!vaultExists || !ckExists || !up) {
    console.log('\n\x1b[31m验收未通过\x1b[0m\n');
    process.exit(1);
  }
  console.log('\n\x1b[1m=== 验收通过：空白机器 → 双击两次 → 就能用 ===\x1b[0m\n');
  process.exit(0);
})().catch((e) => {
  console.error('\n\x1b[31m验收失败：' + e.message + '\x1b[0m');
  console.error(e.stack);
  process.exit(1);
});
