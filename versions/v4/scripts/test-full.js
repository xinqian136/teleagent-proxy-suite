#!/usr/bin/env node
/**
 * test-full.js — 全功能验收
 *
 * 覆盖：纯文本(流式/非流式)、图片(三种格式)、工具往返、Anthropic、Responses、
 *       图+工具组合。用真实照片（从 WorkBuddy 的 blobs 目录找）。
 *
 * 用法: node scripts/test-full.js [端口]
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2] || '8793', 10);
const KEY = process.env.TAV_KEY || 'teleagent-local';

let pass = 0, fail = 0;
const ok = (m) => { console.log('  \x1b[32m✓\x1b[0m ' + m); pass++; };
const bad = (m) => { console.log('  \x1b[31m✗\x1b[0m ' + m); fail++; };

function post(body, p = '/v1/chat/completions') {
  return new Promise((res) => {
    const d = JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d),
        Authorization: 'Bearer ' + KEY, Accept: 'application/json',
      },
    }, (resp) => {
      let t = '';
      resp.on('data', (c) => t += c);
      resp.on('end', () => res({ code: resp.statusCode, body: t }));
    });
    r.on('error', (e) => res({ code: 0, body: e.message }));
    r.write(d); r.end();
  });
}

function postSse(body, p = '/v1/chat/completions') {
  return new Promise((res) => {
    const d = JSON.stringify(body);
    const t0 = Date.now();
    let text = '', first = null, events = 0;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d),
        Authorization: 'Bearer ' + KEY, Accept: 'text/event-stream',
      },
    }, (resp) => {
      resp.on('data', (c) => {
        if (first === null) first = Date.now() - t0;
        text += c.toString('utf8');
        events += (c.toString().match(/data:/g) || []).length;
      });
      resp.on('end', () => res({
        code: resp.statusCode, ct: resp.headers['content-type'] || '',
        text, events, first,
      }));
    });
    r.on('error', (e) => res({ code: 0, body: e.message }));
    r.write(d); r.end();
  });
}

function findPhotos() {
  const dir = 'C:/Users/Administrator/.workbuddy/blobs';
  const out = [];
  try {
    for (const d of fs.readdirSync(dir)) {
      const p = path.join(dir, d);
      if (!fs.statSync(p).isDirectory()) continue;
      for (const f of fs.readdirSync(p)) {
        const fp = path.join(p, f);
        const st = fs.statSync(fp);
        if (/\.(jpg|png)$/i.test(f) && st.size > 40000) out.push({ fp, size: st.size });
      }
    }
  } catch (_) {}
  out.sort((a, b) => a.size - b.size);
  return out;
}

const TOOLS = [{
  type: 'function',
  function: {
    name: 'read_document',
    description: 'Read the content of a document file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
}];

(async () => {
  console.log('\n=== 全功能验收（端口 ' + PORT + '）===\n');

  const photos = findPhotos();
  const small = photos[0], big = photos[photos.length - 1];
  const mimeOf = (fp) => (path.extname(fp).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg');
  const b64Of = (fp) => fs.readFileSync(fp).toString('base64');

  // ---- 1. 纯文本 ----
  console.log('1. 纯文本');
  let r = await post({ model: 'chat-flash', messages: [{ role: 'user', content: '说OK' }] });
  r.code === 200 && JSON.parse(r.body).choices[0].message.content.includes('OK')
    ? ok('非流式 → 200') : bad('非流式 → ' + r.code + ' ' + r.body.slice(0, 100));

  r = await postSse({ model: 'chat-flash', stream: true, messages: [{ role: 'user', content: '用三句话介绍你自己' }] });
  (r.code === 200 && r.ct.includes('event-stream') && r.events > 5)
    ? ok('流式 → 200 SSE ' + r.events + ' 事件，首字节 ' + r.first + 'ms')
    : bad('流式 → ' + r.code + ' ' + (r.ct || r.body || '').slice(0, 100));

  // ---- 2. 图片 ----
  console.log('\n2. 图片');
  if (!small) {
    bad('找不到测试照片');
  } else {
    r = await post({ model: 'chat-flash', messages: [{ role: 'user', content: [
      { type: 'text', text: '这图里是什么？一句话' },
      { type: 'image_url', image_url: { url: 'data:' + mimeOf(small.fp) + ';base64,' + b64Of(small.fp) } },
    ] }] });
    r.code === 200 ? ok('OpenAI base64 小图 → 200 「' + String(JSON.parse(r.body).choices[0].message.content).slice(0, 40) + '」')
      : bad('OpenAI base64 → ' + r.code + ' ' + r.body.slice(0, 120));

    r = await post({ model: 'chat-flash', messages: [{ role: 'user', content: [
      { type: 'text', text: '这图里是什么？一句话' },
      { type: 'image_url', image_url: { url: 'data:' + mimeOf(big.fp) + ';base64,' + b64Of(big.fp) } },
    ] }] });
    r.code === 200 ? ok('OpenAI base64 大图(' + Math.round(b64Of(big.fp).length / 1024) + 'KB) → 200')
      : bad('OpenAI base64 大图 → ' + r.code + ' ' + r.body.slice(0, 120));

    r = await post({ model: 'chat-flash', max_tokens: 200, messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mimeOf(small.fp), data: b64Of(small.fp) } },
      { type: 'text', text: '这图里是什么？一句话' },
    ] }] }, '/v1/messages');
    r.code === 200 ? ok('Anthropic base64 → 200')
      : bad('Anthropic base64 → ' + r.code + ' ' + r.body.slice(0, 120));

    r = await post({ model: 'chat-flash', instructions: '助手', input: [{ role: 'user', content: [
      { type: 'input_text', text: '这图里是什么？一句话' },
      { type: 'input_image', image_url: 'data:' + mimeOf(small.fp) + ';base64,' + b64Of(small.fp) },
    ] }] }, '/v1/responses');
    r.code === 200 ? ok('Responses input_image → 200')
      : bad('Responses → ' + r.code + ' ' + r.body.slice(0, 120));
  }

  // ---- 3. 工具往返 ----
  console.log('\n3. 工具往返');
  const DOC = '预算120万 负责人张三 工期90天';
  r = await postSse({
    model: 'chat-flash', stream: true, tools: TOOLS,
    messages: [{ role: 'user', content: 'Use read_document to read /a.txt, then tell me 负责人 and 预算.' }],
  });
  let tcs = [];
  for (const block of r.text.split(/\n\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const s = line.slice(5).trim();
      if (!s || s === '[DONE]') continue;
      try {
        const j = JSON.parse(s);
        const d = j.choices?.[0]?.delta || {};
        for (const tc of (d.tool_calls || [])) {
          const i = tc.index ?? 0;
          if (!tcs[i]) tcs[i] = { id: '', name: '', args: '' };
          if (tc.id) tcs[i].id = tc.id;
          if (tc.function?.name) tcs[i].name = tc.function.name;
          if (tc.function?.arguments) tcs[i].args += tc.function.arguments;
        }
      } catch (_) {}
    }
  }
  tcs = tcs.filter(Boolean);
  tcs.length ? ok('模型发出工具调用 → ' + tcs[0].name + ' ' + tcs[0].args)
    : bad('模型没发出工具调用');

  if (tcs.length) {
    r = await postSse({
      model: 'chat-flash', stream: true, tools: TOOLS,
      messages: [
        { role: 'user', content: 'Use read_document to read /a.txt, then tell me 负责人 and 预算.' },
        { role: 'assistant', content: '', tool_calls: tcs.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args } })) },
        { role: 'tool', tool_call_id: tcs[0].id, name: tcs[0].name, content: '读取成功：' + DOC },
      ],
    });
    // 提取纯文本内容（SSE 里中文是 \uXXXX 转义，必须先解析再比对）
    let plain = '';
    for (const block of r.text.split(/\n\n/)) {
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const s = line.slice(5).trim();
        if (!s || s === '[DONE]') continue;
        try { plain += JSON.parse(s).choices?.[0]?.delta?.content || ''; } catch (_) {}
      }
    }
    const has120 = plain.includes('120'), hasZs = plain.includes('张三');
    (has120 && hasZs) ? ok('OpenAI 工具结果回传 → 模型正确引用（120/张三）')
      : (console.log('      实际回答: ' + plain.slice(0, 300).replace(/\n/g, ' ')),
         bad('OpenAI 工具往返 → 引用失败 120=' + has120 + ' 张三=' + hasZs));

    r = await post({
      model: 'chat-flash', max_tokens: 300,
      messages: [
        { role: 'user', content: '读取 /a.txt' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'read_document', input: { path: '/a.txt' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '读取成功：' + DOC }] },
      ],
    }, '/v1/messages');
    const a120 = r.code === 200 && r.body.includes('120'), aZs = r.code === 200 && r.body.includes('张三');
    (a120 && aZs) ? ok('Anthropic tool_result → 模型正确引用（120/张三）')
      : bad('Anthropic 工具往返 → 120=' + a120 + ' 张三=' + aZs + ' ' + r.body.slice(0, 100));
  }

  // ---- 4. 图 + 工具组合 ----
  console.log('\n4. 图 + 工具结果组合');
  if (small) {
    r = await post({
      model: 'chat-flash', max_tokens: 400,
      messages: [
        { role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mimeOf(small.fp), data: b64Of(small.fp) } },
          { type: 'text', text: '看这张图，然后调用 read_document 读取 /a.txt' },
        ] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'read_document', input: { path: '/a.txt' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '文档内容：' + DOC }] },
      ],
    }, '/v1/messages');
    const gotImg = r.code === 200 && /益达|口香糖|瓶|菊|包装|图/.test(r.body);
    const gotDoc = r.code === 200 && (r.body.includes('120') || r.body.includes('张三'));
    (gotImg && gotDoc) ? ok('图 + 工具结果同时正确引用')
      : bad('组合场景 → 图=' + gotImg + ' 文档=' + gotDoc + ' ' + r.body.slice(0, 140));
  }

  // ---- 5. 协议兼容 ----
  console.log('\n5. 协议兼容');
  r = await post({ model: 'chat-flash', max_tokens: 100, messages: [{ role: 'user', content: '说OK' }] }, '/v1/messages');
  (r.code === 200 && JSON.parse(r.body).type === 'message') ? ok('Anthropic 协议 → 200') : bad('Anthropic → ' + r.code);

  r = await post({ model: 'chat-flash', instructions: '助手', input: [{ role: 'user', content: '说OK' }] }, '/v1/responses');
  (r.code === 200 && JSON.parse(r.body).object === 'response') ? ok('Responses 协议 → 200') : bad('Responses → ' + r.code);

  r = await post({ model: 'chat-flash', messages: [{ role: 'user', content: '说OK' }] });
  const j = r.code === 200 ? JSON.parse(r.body) : null;
  (j && j.request_id && j.usage && j.choices[0].message.reasoning_content)
    ? ok('响应字段完整（request_id/usage/reasoning_content）')
    : bad('响应字段不完整');

  // ---- 6. 模型别名 chat-flagshipAuto ----
  console.log('\n6. 模型别名');
  const models = await new Promise((res) => {
    const q = http.request({ host: '127.0.0.1', port: PORT, path: '/v1/models', method: 'GET', headers: { Authorization: 'Bearer ' + KEY } }, (resp) => {
      let t = ''; resp.on('data', (c) => t += c);
      resp.on('end', () => { try { res(JSON.parse(t).data.map((m) => m.id)); } catch (_) { res([]); } });
    });
    q.on('error', () => res([]));
    q.end();
  });
  models.includes('chat-flagshipAuto') ? ok('/v1/models 含 chat-flagshipAuto') : bad('/v1/models 没有别名模型');

  if (small) {
    r = await post({ model: 'chat-flagshipAuto', messages: [{ role: 'user', content: [
      { type: 'text', text: '这图里是什么？一句话' },
      { type: 'image_url', image_url: { url: 'data:' + mimeOf(small.fp) + ';base64,' + b64Of(small.fp) } },
    ] }] });
    if (r.code === 200) {
      const j = JSON.parse(r.body);
      const txt = String(j.choices[0].message.content);
      const sees = /益达|口香糖|瓶|菊|包装/.test(txt);
      (j.model && j.model !== 'chat-flagshipAuto')
        ? ok('chat-flagshipAuto 带图 → 实际模型 ' + j.model + (sees ? '，✓ 看到图' : '，✗ 看不到图'))
        : bad('别名没生效，模型=' + j.model);
      if (!sees) fail++;
    } else bad('别名带图 → ' + r.code);
  }

  r = await post({ model: 'chat-flagshipAuto', messages: [{ role: 'user', content: '说OK' }] });
  (r.code === 200 && JSON.parse(r.body).model === 'chat-flagship')
    ? ok('chat-flagshipAuto 纯文本 → chat-flagship')
    : bad('别名纯文本 → 模型=' + (r.code === 200 ? JSON.parse(r.body).model : r.code));

  console.log('\n' + '─'.repeat(46));
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('─'.repeat(46) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e.message); process.exit(1); });
