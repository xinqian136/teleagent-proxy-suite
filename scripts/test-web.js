#!/usr/bin/env node
/**
 * test-web.js — v3 端到端验收
 *
 * 用真实 HTTP 请求走一遍所有 Web 功能：
 *   界面静态资源 → 管理 API → 账号增删改 → 导入导出 → 设置热重载 → 反代推理
 *
 * 用法: node scripts/test-web.js [端口]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB_PORT = parseInt(process.argv[2] || '8795', 10);
let pass = 0, fail = 0;

function ok(m) { console.log('  \x1b[32m✓\x1b[0m ' + m); pass++; }
function bad(m) { console.log('  \x1b[31m✗\x1b[0m ' + m); fail++; }

function req(pathname, method, body, port = WEB_PORT, headers = {}) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method: method || 'GET', headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => b += c);
      resp.on('end', () => res({ code: resp.statusCode, body: b }));
    });
    r.on('error', (e) => res({ code: 0, body: e.message }));
    if (d) r.write(d);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n\x1b[1m=== v3 Web 端到端验收 ===\x1b[0m\n');

  // 1. 静态资源
  console.log('1. 界面资源');
  let r = await req('/');
  r.code === 200 && r.body.includes('TeleAgent 反代') ? ok('GET /  → 200，含标题') : bad('GET / 失败');
  r = await req('/app.js');
  r.code === 200 && r.body.length > 5000 ? ok(`GET /app.js → 200，${r.body.length} 字节`) : bad('/app.js 失败');
  r = await req('/style.css');
  r.code === 200 ? ok('GET /style.css → 200') : bad('/style.css 失败');

  // 2. 概览
  console.log('\n2. 管理 API');
  r = await req('/api/admin/overview');
  const ov = JSON.parse(r.body);
  r.code === 200 ? ok(`overview → 账号 ${ov.accounts.total} 个，反代 ${ov.proxy.state}`) : bad('overview 失败');

  // 3. 扫描
  r = await req('/api/admin/scan', 'POST', {});
  const sc = JSON.parse(r.body);
  r.code === 200 ? ok(`scan → 新增 ${sc.added}，更新 ${sc.updated}`) : bad('scan 失败：' + r.body.slice(0, 100));

  // 4. 账号列表
  r = await req('/api/admin/accounts');
  const accs = JSON.parse(r.body).accounts;
  accs.length ? ok(`accounts → ${accs.length} 个账号`) : bad('没有账号');
  if (!accs.length) { console.log('\n没有账号，后续测试跳过\n'); process.exit(1); }
  const acc = accs[0];
  console.log(`     ${acc.accountName} | ${acc.tenant} | ${acc.status} | ${acc.expiresIn}`);

  // 5. 改账号
  console.log('\n3. 账号操作');
  r = await req('/api/admin/account', 'PUT', { id: acc.id, note: '验收备注' });
  r.code === 200 ? ok('PUT account → 200') : bad('改账号失败');
  r = await req('/api/admin/accounts');
  const a2 = JSON.parse(r.body).accounts.find((x) => x.id === acc.id);
  a2.note === '验收备注' ? ok('备注已写入并回读') : bad('备注没生效');

  r = await req('/api/admin/account', 'PUT', { id: acc.id, status: 'disabled' });
  r = await req('/api/admin/accounts');
  const a3 = JSON.parse(r.body).accounts.find((x) => x.id === acc.id);
  a3.status === 'disabled' ? ok('禁用生效') : bad('禁用没生效');
  await req('/api/admin/account', 'PUT', { id: acc.id, status: 'active' });

  // 6. 导出
  console.log('\n4. 导入导出');
  r = await req('/api/admin/export', 'POST', { format: 'bundle', password: 'acc-test' });
  const ex = JSON.parse(r.body);
  ex.count && ex.encrypted ? ok(`export bundle → ${ex.count} 个，已加密`) : bad('导出失败：' + r.body.slice(0, 100));
  ex.content.includes('eyJ') ? bad('bundle 含明文 token') : ok('bundle 不含明文 token');

  r = await req('/api/admin/export', 'POST', { format: 'xlsx' });
  const ex2 = JSON.parse(r.body);
  ex2.downloadUrl ? ok('export xlsx → ' + ex2.filename) : bad('xlsx 导出失败');
  if (ex2.downloadUrl) {
    r = await req(ex2.downloadUrl);
    r.code === 200 ? ok('xlsx 可下载 → 200') : bad('xlsx 下载失败');
  }

  // 7. 导入回环
  r = await req('/api/admin/import', 'POST', { content: ex.content, password: 'acc-test' });
  const im = JSON.parse(r.body);
  r.code === 200 ? ok(`import 回环 → 新增 ${im.added}，更新 ${im.updated}`) : bad('导入失败：' + r.body.slice(0, 100));

  // 8. 错误口令应被拒
  r = await req('/api/admin/import', 'POST', { content: ex.content, password: 'wrong' });
  r.code !== 200 ? ok('错误口令被拒绝 → ' + r.code) : bad('错误口令竟然通过了');

  // 9. 设置热重载
  console.log('\n5. 设置与热重载');
  const before = JSON.parse((await req('/api/admin/proxy')).body).proxy;
  const newPort = before.port === 8798 ? 8799 : 8798;
  const newKey = 'test-key-' + Date.now();
  r = await req('/api/admin/settings', 'PUT', { 'proxy.port': newPort, 'proxy.apiKey': newKey });
  const st = JSON.parse(r.body);
  st.settings.proxy.port === newPort ? ok(`端口已改 → ${newPort}`) : bad('端口没改：' + JSON.stringify(st.settings.proxy));
  st.settings.proxy.apiKey === newKey ? ok('API Key 已改') : bad('API Key 没改');
  st.proxyRestarted ? ok('反代已热重启') : ok('反代未运行，无需重启');

  await sleep(1500);

  // 10. 新端口 + 新 key 推理
  const px = JSON.parse((await req('/api/admin/proxy')).body).proxy;
  if (px.state === 'running') {
    r = await req('/v1/chat/completions', 'POST',
      { model: 'chat-flash', messages: [{ role: 'user', content: '说OK' }] },
      px.port, { Authorization: 'Bearer ' + newKey });
    r.code === 200 ? ok('新端口 + 新 key 推理 → 200 ' + JSON.parse(r.body).choices[0].message.content)
      : bad('推理失败：' + r.body.slice(0, 120));

    r = await req('/v1/chat/completions', 'POST',
      { model: 'chat-flash', messages: [{ role: 'user', content: 'hi' }] },
      px.port, { Authorization: 'Bearer old-key' });
    r.code === 401 ? ok('旧 key 被拒 → 401') : bad('旧 key 没被拒：' + r.code);
  } else {
    bad('反代没起来：' + (px.error || px.state));
  }

  // 11. 恢复默认
  r = await req('/api/admin/settings', 'PUT', { 'proxy.port': before.port, 'proxy.apiKey': before.apiKey });
  JSON.parse(r.body).settings.proxy.port === before.port ? ok(`已恢复端口 ${before.port}`) : bad('恢复失败');
  await sleep(1200);

  // 12. 对话测试
  console.log('\n6. 其它');
  r = await req('/api/admin/test', 'POST', { message: '用一句话说你是谁', model: 'chat-flash' });
  r.code === 200 ? ok('对话测试 → 200') : bad('对话测试失败：' + r.body.slice(0, 120));

  r = await req('/api/admin/client-config');
  const cc = JSON.parse(r.body);
  cc.configs && cc.configs['Cherry Studio'] ? ok('客户端配置生成正常') : bad('客户端配置异常');

  r = await req('/api/admin/logs?n=50');
  JSON.parse(r.body).logs ? ok('日志接口正常') : bad('日志接口异常');

  r = await req('/api/admin/refresh', 'POST', {});
  r.code === 200 ? ok('立即续期接口正常') : bad('续期接口失败：' + r.body.slice(0, 100));

  console.log('\n' + '─'.repeat(46));
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log('─'.repeat(46) + '\n');
  process.exit(fail ? 1 : 0);
})();
