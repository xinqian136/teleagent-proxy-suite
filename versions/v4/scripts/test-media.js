// 端到端：同一个进程内起图床 + 跑 v3 的 handleInference 路径
// 证明 media 转换在完整链路里生效
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const png = fs.readFileSync('/c/Users/Administrator/WorkBuddy/2026-11-18-10-35-09/teleagent-proxy-v3/scripts/test-image.png');

const srv = http.createServer((q, s) => {
  s.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
  s.end(png);
});

srv.listen(8899, '127.0.0.1', async () => {
  console.log('进程内图床已起');

  const { createStore } = require(path.join(ROOT, 'lib', 'storage'));
  const { ProxyManager } = require(path.join(ROOT, 'lib', 'web', 'manager'));
  const { Settings } = require(path.join(ROOT, 'lib', 'web', 'settings'));

  const store = createStore({ dataDir: path.join(ROOT, 'data'), kind: 'json' });
  const settings = new Settings({ file: path.join(ROOT, 'config', 'settings.json') });
  // 用一个临时端口，别撞上正在跑的实例
  settings.set('proxy.port', 8891);
  settings.set('proxy.paused', false);

  const logs = [];
  const manager = new ProxyManager({
    store, settings, root: ROOT,
    log: (m) => { logs.push(m); console.log('  [log]', m); },
  });

  const r = await manager.start();
  if (!r.ok) { console.log('反代启动失败:', r.error); srv.close(); process.exit(1); }

  function post(body, p = '/v1/chat/completions') {
    return new Promise((res) => {
      const d = JSON.stringify(body);
      const rq = http.request({
        host: '127.0.0.1', port: 8891, path: p, method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d),
          Authorization: 'Bearer ' + settings.get('proxy.apiKey'), Accept: 'application/json',
        },
      }, (resp) => {
        let t = ''; resp.on('data', (c) => t += c);
        resp.on('end', () => res({ code: resp.statusCode, body: t }));
      });
      rq.on('error', (e) => res({ code: 0, body: e.message }));
      rq.write(d); rq.end();
    });
  }

  const REMOTE = 'http://127.0.0.1:8899/test.png';

  console.log('\n=== 远程 URL 图片（OpenAI 协议）===');
  let resp = await post({
    model: 'chat-flash',
    messages: [{ role: 'user', content: [
      { type: 'text', text: '这图什么颜色？只答颜色' },
      { type: 'image_url', image_url: { url: REMOTE } },
    ] }],
  });
  if (resp.code === 200) {
    const j = JSON.parse(resp.body);
    console.log('  HTTP 200 |', String(j.choices[0].message.content).slice(0, 120).replace(/\n/g, ' '));
  } else console.log('  HTTP', resp.code, resp.body.slice(0, 180));

  console.log('\n=== 远程 URL 图片（Anthropic 协议）===');
  resp = await post({
    model: 'chat-flash', max_tokens: 200,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'url', url: REMOTE } },
      { type: 'text', text: '这图什么颜色？只答颜色' },
    ] }],
  }, '/v1/messages');
  if (resp.code === 200) {
    const j = JSON.parse(resp.body);
    console.log('  HTTP 200 |', String(j.content?.find((c) => c.type === 'text')?.text || '').slice(0, 120).replace(/\n/g, ' '));
  } else console.log('  HTTP', resp.code, resp.body.slice(0, 180));

  console.log('\n=== base64 图片（回归：本来就能用）===');
  resp = await post({
    model: 'chat-flash',
    messages: [{ role: 'user', content: [
      { type: 'text', text: '这图什么颜色？只答颜色' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64') } },
    ] }],
  });
  if (resp.code === 200) {
    const j = JSON.parse(resp.body);
    console.log('  HTTP 200 |', String(j.choices[0].message.content).slice(0, 120).replace(/\n/g, ' '));
  } else console.log('  HTTP', resp.code, resp.body.slice(0, 180));

  await manager.stop();
  srv.close();
  process.exit(0);
});
