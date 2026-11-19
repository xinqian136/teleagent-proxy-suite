// 模拟 WorkBuddy 的完整工作流：流式 + 工具往返 + 多模态/文件内容块
// 验证 v3 修复后能否正确处理复杂任务
const http = require('http');

const PORT = process.env.PORT || 8792;
const KEY = process.env.KEY || 'teleagent-local';

const TOOLS = [{
  type: 'function',
  function: {
    name: 'read_document',
    description: 'Read the content of a document file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path' },
      },
      required: ['path'],
    },
  },
}];

function sseRequest(body) {
  return new Promise((res) => {
    const d = JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: '/v1/chat/completions', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(d),
        Authorization: 'Bearer ' + KEY,
        Accept: 'text/event-stream',
      },
    }, (resp) => {
      let buf = '';
      const chunks = [];
      resp.on('data', (c) => { buf += c.toString('utf8'); chunks.push(c); });
      resp.on('end', () => res({ code: resp.statusCode, body: buf, raw: chunks }));
    });
    r.on('error', (e) => res({ code: 0, body: e.message }));
    r.write(d); r.end();
  });
}

/** 解析 OpenAI SSE → {text, reasoning, toolCalls, finishReason} */
function parseOpenAI(sseText) {
  const out = { text: '', reasoning: '', toolCalls: [], finishReason: null, chunks: 0 };
  for (const block of sseText.split(/\n\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let j;
      try { j = JSON.parse(data); } catch (_) { continue; }
      out.chunks++;
      const ch = j.choices?.[0];
      if (!ch) continue;
      const d = ch.delta || {};
      if (typeof d.content === 'string') out.text += d.content;
      if (typeof d.reasoning_content === 'string') out.reasoning += d.reasoning_content;
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index ?? 0;
          if (!out.toolCalls[i]) out.toolCalls[i] = { id: '', name: '', args: '' };
          if (tc.id) out.toolCalls[i].id = tc.id;
          if (tc.function?.name) out.toolCalls[i].name = tc.function.name;
          if (tc.function?.arguments) out.toolCalls[i].args += tc.function.arguments;
        }
      }
      if (ch.finish_reason) out.finishReason = ch.finish_reason;
    }
  }
  out.toolCalls = out.toolCalls.filter(Boolean);
  return out;
}

(async () => {
  console.log(`\n=== 模拟 WorkBuddy 复杂任务流程（端口 ${PORT}）===\n`);

  // 场景：用户上传了文档，WorkBuddy 把文档内容 + 工具定义发过来
  const docContent = '项目名称：广东泛瑞新材料  预算：120万  工期：90天  负责人：张三';

  console.log('【第 1 轮】用户消息里带文档内容块（content 是数组）');
  const msgs = [
    {
      role: 'user',
      content: [
        { type: 'text', text: '请读取附件里的项目信息并汇总成一段话。' },
        { type: 'text', text: '[附件内容] ' + docContent },
      ],
    },
  ];
  let r = await sseRequest({ model: 'chat-flash', stream: true, messages: msgs, tools: TOOLS });
  let p = parseOpenAI(r.body);
  console.log('  HTTP', r.code, '| SSE 块数', p.chunks, '| finish:', p.finishReason);
  console.log('  tool_calls:', JSON.stringify(p.toolCalls));
  console.log('  文本片段:', p.text.slice(0, 80));

  if (!p.toolCalls.length) {
    console.log('\n  ⚠ 模型没调用工具，换 prompt 再试…');
    msgs[0].content[0].text = 'Use the read_document tool to read /tmp/a.docx, then summarize it.';
    r = await sseRequest({ model: 'chat-flash', stream: true, messages: msgs, tools: TOOLS });
    p = parseOpenAI(r.body);
    console.log('  tool_calls:', JSON.stringify(p.toolCalls));
  }

  if (!p.toolCalls.length) { console.log('\n  无法继续测工具往返'); process.exit(0); }

  // 第 2 轮：WorkBuddy 执行工具，把结果回传
  console.log('\n【第 2 轮】工具结果回传（role=tool + tool_call_id）');
  const tc = p.toolCalls[0];
  const toolResult = `读取成功：${docContent}`;
  const msgs2 = [
    ...msgs,
    { role: 'assistant', content: p.text || '', tool_calls: p.toolCalls.map((t) => ({
      id: t.id, type: 'function', function: { name: t.name, arguments: t.args },
    })) },
    { role: 'tool', tool_call_id: tc.id, name: tc.name, content: toolResult },
  ];
  r = await sseRequest({ model: 'chat-flash', stream: true, messages: msgs2, tools: TOOLS });
  const p2 = parseOpenAI(r.body);
  console.log('  HTTP', r.code, '| SSE 块数', p2.chunks);
  console.log('  最终回答:', p2.text.slice(0, 200));
  console.log('');
  console.log('  ★ 是否正确引用了工具结果里的内容（120万 / 张三）:');
  const ok1 = p2.text.includes('120万') || p2.text.includes('120');
  const ok2 = p2.text.includes('张三');
  console.log('    预算 120万:', ok1 ? '✓' : '✗');
  console.log('    负责人 张三:', ok2 ? '✓' : '✗');
  console.log('    finish_reason:', p2.finishReason);
})();
