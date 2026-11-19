// 测跨进程实时同步：外部 scan/改状态后，服务端立刻感知
const http = require('http');
const { createStore } = require('../lib/storage');

function req(path, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { Authorization: 'Bearer teleagent-local' };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: 8792, path, method: body ? 'POST' : 'GET', headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => b += c); resp.on('end', () => res({ code: resp.statusCode, body: b }));
    });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const store = createStore({ dataDir: './data' });

  console.log('===== 1. 正常状态 =====');
  let r = await req('/health');
  let h = JSON.parse(r.body);
  console.log('  可用账号:', h.accounts.usable + '/' + h.accounts.total);

  console.log('');
  console.log('===== 2. 外部进程禁用账号 → 服务应立刻感知 =====');
  const rec = store.list()[0];
  store.update(rec.id, { status: 'disabled' });
  await sleep(300);
  r = await req('/v1/chat/completions', { model: 'chat-flagship', messages: [{ role: 'user', content: 'hi' }] });
  console.log('  HTTP', r.code, '| 类型:', JSON.parse(r.body).error?.type);

  console.log('');
  console.log('===== 3. 外部进程重新启用 → 服务应立刻恢复 =====');
  store.update(rec.id, { status: 'active' });
  await sleep(300);
  r = await req('/v1/chat/completions', { model: 'chat-flagship', messages: [{ role: 'user', content: '说OK' }] });
  console.log('  HTTP', r.code, '|', r.code === 200 ? JSON.parse(r.body).choices[0].message.content : r.body.slice(0, 80));

  console.log('');
  console.log('===== 4. 并发写测试（10 个进程同时改状态）=====');
  const { execFileSync } = require('child_process');
  const node = process.execPath;
  const script = `
    const {createStore}=require('${require('path').resolve(__dirname, '../lib/storage').replace(/\\/g, '\\\\')}');
    const s=createStore({dataDir:'${require('path').resolve(__dirname, '../data').replace(/\\/g, '\\\\')}'});
    const r=s.list()[0];
    s.update(r.id,{note:'w'+process.argv[2]});
  `;
  const p = [];
  for (let i = 0; i < 10; i++) {
    p.push(new Promise((res) => {
      try {
        execFileSync(node, ['-e', script, String(i)], { timeout: 15000 });
        res();
      } catch (e) { res(); }
    }));
  }
  await Promise.all(p);
  await sleep(300);
  const after = store.list()[0];
  console.log('  10 次并发写后:', after.note ? `note=${after.note}` : '(无 note)');
  console.log('  账号仍完好?', after.token ? '✓ token 在' : '✗ token 丢了');
  console.log('  账号数:', store.list().length);

  console.log('');
  console.log('===== 5. 最终状态 =====');
  r = await req('/health');
  h = JSON.parse(r.body);
  console.log('  可用账号:', h.accounts.usable + '/' + h.accounts.total);
})();
