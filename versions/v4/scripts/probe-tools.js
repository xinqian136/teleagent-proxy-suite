// 实测：网关对 tool 消息往返的处理
// 用来判断 v3 丢失 tool_call_id / tool_result 是不是根因
const http = require('http');

const PORT = 8793;
const KEY = 'teleagent-local';

const TOOLS = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'city name' } },
      required: ['city'],
    },
  },
}];

function chat(messages, tools) {
  return new Promise((res) => {
    const body = { model: 'chat-flash', messages, stream: false };
    if (tools) body.tools = tools;
    const data = JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: '/v1/chat/completions', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        Authorization: 'Bearer ' + KEY,
      },
    }, (resp) => {
      let b = ''; resp.on('data', (c) => b += c);
      resp.on('end', () => res({ code: resp.statusCode, body: b }));
    });
    r.on('error', (e) => res({ code: 0, body: e.message }));
    r.write(data); r.end();
  });
}

(async () => {
  console.log('\n=== 第 1 轮：带 tools，看模型是否返回 tool_calls ===');
  const userMsg = { role: 'user', content: '请查一下北京现在的天气，然后用一句话告诉我结果。' };
  let r = await chat([userMsg], TOOLS);
  console.log('HTTP', r.code);
  const j = JSON.parse(r.body);
  const msg = j.choices?.[0]?.message || {};
  console.log('  tool_calls:', JSON.stringify(msg.tool_calls || []));
  console.log('  content   :', String(msg.content || '').slice(0, 120));

  if (!msg.tool_calls || !msg.tool_calls.length) {
    console.log('\n  模型没返回 tool_calls，换个 prompt 再试...');
    r = await chat([{ role: 'user', content: 'Use the get_weather tool to find the weather in Beijing.' }], TOOLS);
    const j2 = JSON.parse(r.body);
    const m2 = j2.choices?.[0]?.message || {};
    console.log('  第二次 tool_calls:', JSON.stringify(m2.tool_calls || []));
    if (!m2.tool_calls?.length) { console.log('\n  网关不返回工具调用，无法继续测'); process.exit(0); }
    return;
  }

  const tc = msg.tool_calls[0];
  const toolResult = '北京现在晴，气温 25 度，微风。';

  // ---------- 场景 A：标准格式，带 tool_call_id ----------
  console.log('\n=== 场景 A：标准 tool 消息（带 tool_call_id）===');
  r = await chat([
    userMsg,
    { role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls },
    { role: 'tool', tool_call_id: tc.id, content: toolResult },
  ], TOOLS);
  const a = JSON.parse(r.body);
  console.log('  HTTP', r.code);
  console.log('  回复:', String(a.choices?.[0]?.message?.content || '').slice(0, 160));
  console.log('  是否引用了工具结果(25度):',
    String(a.choices?.[0]?.message?.content || '').includes('25') ? '✓ 是' : '✗ 否');

  // ---------- 场景 B：v3 当前行为 —— 丢掉 tool_call_id ----------
  console.log('\n=== 场景 B：v3 当前行为（丢掉 tool_call_id，只留 role+content）===');
  r = await chat([
    userMsg,
    { role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls },
    { role: 'tool', content: toolResult },
  ], TOOLS);
  const b = JSON.parse(r.body);
  console.log('  HTTP', b.code);
  console.log('  回复:', String(b.choices?.[0]?.message?.content || '').slice(0, 160));
  console.log('  是否引用了工具结果(25度):',
    String(b.choices?.[0]?.message?.content || '').includes('25') ? '✓ 是' : '✗ 否');

  // ---------- 场景 C：完全丢掉 tool 消息 ----------
  console.log('\n=== 场景 C：完全丢掉工具结果消息（历史里只剩 user）===');
  r = await chat([userMsg], TOOLS);
  const c = JSON.parse(r.body);
  console.log('  HTTP', c.code);
  console.log('  回复:', String(c.choices?.[0]?.message?.content || '').slice(0, 160));
  console.log('  是否引用了工具结果(25度):',
    String(c.choices?.[0]?.message?.content || '').includes('25') ? '✓ 是' : '✗ 否');
})();
