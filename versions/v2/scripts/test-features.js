// 测 v2 的自定义 tools 与账号失效降级
const http = require('http');

function req(path, body, headers) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...(headers || {}) };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: 8792, path, method: body ? 'POST' : 'GET', headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => b += c); resp.on('end', () => res({ code: resp.statusCode, body: b }));
    });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}

const TOOLS = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
}];

(async () => {
  console.log('===== 1. 自定义 tools =====');
  const r = await req('/v1/chat/completions', {
    model: 'chat-flagship',
    messages: [{ role: 'user', content: 'What is the weather in Beijing? Use the get_weather tool.' }],
    tools: TOOLS,
    tool_choice: 'auto',
  }, { Authorization: 'Bearer teleagent-local' });

  const j = JSON.parse(r.body);
  console.log('  HTTP', r.code);
  if (r.code !== 200) { console.log('  ', r.body.slice(0, 200)); }
  else {
    const m = j.choices[0].message;
    console.log('  tool_calls:', JSON.stringify((m.tool_calls || []).map((t) => ({
      name: t.function.name, args: t.function.arguments,
    }))));
    console.log('  finish_reason:', j.choices[0].finish_reason);
    console.log('  推理 tokens:', j.usage?.completion_tokens_details?.reasoning_tokens ?? '-');
  }

  console.log('');
  console.log('===== 2. 无账号时的降级（临时把账号全禁用）=====');
  const fs = require('fs');
  const path = require('path');
  const { createStore } = require('../lib/storage');
  const store = createStore({ dataDir: './data' });
  const list = store.list();
  const saved = list.map((r) => ({ id: r.id, status: r.status }));
  list.forEach((r) => store.put({ ...r, status: 'disabled' }));

  const r2 = await req('/v1/chat/completions', {
    model: 'chat-flagship',
    messages: [{ role: 'user', content: 'hi' }],
  }, { Authorization: 'Bearer teleagent-local' });
  console.log('  HTTP', r2.code);
  const e2 = JSON.parse(r2.body);
  console.log('  错误类型:', e2.error?.type);
  console.log('  提示:', String(e2.error?.message).slice(0, 100));

  // 恢复
  saved.forEach((s) => { const rec = store.get(s.id); if (rec) store.put({ ...rec, status: s.status }); });
  console.log('  ✓ 已恢复账号状态');

  console.log('');
  console.log('===== 3. 恢复后再试一次 =====');
  const r3 = await req('/v1/chat/completions', {
    model: 'chat-flagship', messages: [{ role: 'user', content: '说OK' }],
  }, { Authorization: 'Bearer teleagent-local' });
  console.log('  HTTP', r3.code, '|', JSON.parse(r3.body).choices?.[0]?.message?.content || r3.body.slice(0, 80));
})();
