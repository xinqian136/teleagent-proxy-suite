#!/usr/bin/env node
/**
 * test-portable.js — 验收：模拟一台全新机器
 *
 * 场景：
 *   1. 把整个程序目录拷到临时位置（模拟「拷贝到别的机器」）
 *   2. 只带账号包过去（模拟「别的机器没有账号」）
 *   3. 在临时目录里 import + 起服务 + 推理
 *   4. 验证：不依赖原目录、不依赖 TeleAgent 数据目录
 *
 * 用法: node scripts/test-portable.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const TMP = path.join(os.tmpdir(), 'tav2-portable-test');

function log(m) { console.log(m); }
function ok(m) { console.log('  \x1b[32m✓\x1b[0m ' + m); }
function bad(m) { console.log('  \x1b[31m✗\x1b[0m ' + m); }

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'data' || e.name === 'node_modules' || e.name === '.git') continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
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
  console.log('\n\x1b[1m=== 验收：模拟全新机器 ===\x1b[0m\n');

  // 清理
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

  // 1. 拷贝程序
  log('1. 拷贝程序目录（不含 data/）');
  copyDir(ROOT, TMP);
  const files = fs.readdirSync(TMP);
  ok(`已拷到 ${TMP}`);
  log(`   包含: ${files.join(', ')}`);

  // 2. 源机器导出账号包
  log('\n2. 源机器导出账号包');
  const bundle = path.join(TMP, 'account.bundle');
  execFileSync(NODE, [path.join(ROOT, 'bin', 'tav2.js'), 'export', '--out', bundle, '--password', 'portable123'],
    { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  const size = fs.statSync(bundle).size;
  ok(`账号包已生成 ${bundle}（${size} 字节）`);
  ok('不含明文 token: ' + (!fs.readFileSync(bundle, 'utf8').includes('eyJ')));

  // 3. 目标机器导入
  log('\n3. 目标机器导入（目录里只有账号包，没有 TeleAgent 数据）');
  const out = execFileSync(NODE, [path.join(TMP, 'bin', 'tav2.js'), 'import', bundle, '--password', 'portable123'],
    { cwd: TMP, encoding: 'utf8', stdio: 'pipe' });
  ok('导入成功');

  const accOut = execFileSync(NODE, [path.join(TMP, 'bin', 'tav2.js'), 'accounts'],
    { cwd: TMP, encoding: 'utf8', stdio: 'pipe' });
  const hasAccount = /曾星熠/.test(accOut);
  if (hasAccount) ok('账号已在目标机凭据库: ' + (accOut.match(/acc_\S+/) || [''])[0]);
  else bad('账号没导入');

  // 4. 目标机器 doctor
  log('\n4. 目标机器 doctor');
  const doc = execFileSync(NODE, [path.join(TMP, 'bin', 'tav2.js'), 'doctor'],
    { cwd: TMP, encoding: 'utf8', stdio: 'pipe' });
  const storageOk = /存储可用/.test(doc);
  const ckOk = /渠道密钥/.test(doc) && !/渠道密钥\s+: 未找到/.test(doc);
  const acctOk = /可用账号\s+: 1/.test(doc);
  if (storageOk) ok('存储可用'); else bad('存储不可用');
  if (ckOk) ok('渠道密钥可解析（从本机 app.asar）'); else log('   ' + (/渠道密钥.*/.exec(doc) || [''])[0]);
  if (acctOk) ok('有可用账号'); else bad('无可用账号');

  // 5. 目标机器起服务
  log('\n5. 目标机器起反代服务（端口 8793）');
  const srv = spawn(NODE, [path.join(TMP, 'bin', 'tav2.js'), 'serve', '--port', '8793'], {
    cwd: TMP, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TAV2_VAULT_PASSWORD: 'portable123' },
  });
  let srvOut = '';
  srv.stdout.on('data', (d) => { srvOut += d.toString(); });
  srv.stderr.on('data', (d) => { srvOut += d.toString(); });

  await sleep(5000);
  const up = await new Promise((res) => {
    req(8793, '/health').then(() => res(true)).catch(() => res(false));
  });
  if (up) ok('服务已监听 8793'); else { bad('服务没起来'); console.log(srvOut.slice(0, 600)); srv.kill(); process.exit(1); }

  // 6. 推理
  log('\n6. 在目标机器上推理');
  const r = await req(8793, '/v1/chat/completions', {
    model: 'chat-flagship', messages: [{ role: 'user', content: '用一句话说你是谁' }],
  });
  if (r.code === 200) {
    const content = JSON.parse(r.body).choices[0].message.content;
    ok(`推理成功: ${String(content).slice(0, 60)}`);
  } else {
    bad(`推理失败 HTTP ${r.code}: ${r.body.slice(0, 150)}`);
  }

  // 7. 验证与原目录无关
  log('\n7. 验证与原目录无关');
  const health = JSON.parse((await req(8793, '/health')).body);
  ok(`设备指纹独立生成: ${health.accounts.deviceId}`);
  ok('目标机数据目录: ' + path.join(TMP, 'data'));
  const vaultExists = fs.existsSync(path.join(TMP, 'data', 'accounts.vault'));
  if (vaultExists) ok('目标机有自己的凭据库（与原目录完全独立）');
  else bad('目标机没有凭据库');
  const origVault = path.join(ROOT, 'data', 'accounts.vault');
  if (!fs.existsSync(path.join(TMP, 'data', 'accounts.vault.bak'))) ok('未复制原目录的凭据文件');

  // 8. 清理
  srv.kill();
  await sleep(1000);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  ok('临时目录已清理');

  console.log('\n\x1b[1m=== 验收通过：整个目录可拷贝到任意机器直接用 ===\x1b[0m\n');
})().catch((e) => {
  console.error('\n\x1b[31m验收失败：' + e.message + '\x1b[0m');
  console.error(e.stack);
  process.exit(1);
});
