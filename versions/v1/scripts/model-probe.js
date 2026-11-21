#!/usr/bin/env node
/**
 * model-probe.js — 实测各模型：延迟、是否出 reasoning、是否支持 tools、usage 统计。
 *
 * 用方案 A（直连网关），因为只有它能测自定义 tools 的原生支持。
 */
const { getToken } = require('./ta-token');
const { chatCompletion } = require('./ta-gateway');

const MODELS = ['chat-pro', 'chat-flagship', 'chat-flash', 'chat-lite', 'chat-nano'];

(async () => {
  const { token } = getToken();
  console.log('%-16s %6s %8s %8s %6s %6s %s' % ('model', 'HTTP', '耗时s', 'in_tok', 'out_tok', 'reason', 'tools支持'));
  console.log('-'.repeat(78));

  for (const m of MODELS) {
    // 1) 普通对话
    let row = { m, http: '-', sec: '-', in: '-', out: '-', reason: '-', tools: '-' };
    try {
      const t = Date.now();
      const r = await chatCompletion({
        model: m, messages: [{ role: 'user', content: '用一句话说明什么是反向代理' }], stream: false,
      }, { signVariant: 'v3' });
      row.sec = ((Date.now() - t) / 1000).toFixed(1);
      row.http = r.status;
      if (r.status === 200) {
        const j = JSON.parse(r.text);
        const msg = j.choices[0].message;
        row.in = j.usage ? j.usage.prompt_tokens : '?';
        row.out = j.usage ? j.usage.completion_tokens : '?';
        row.reason = (j.usage && j.usage.completion_tokens_details && j.usage.completion_tokens_details.reasoning_tokens) ? 'Y' : 'n';
        row.text = (msg.content || '').length;
      }
    } catch (e) { row.http = 'ERR'; row.sec = e.message.slice(0, 20); }

    // 2) tools 支持
    try {
      const r2 = await chatCompletion({
        model: m,
        messages: [{ role: 'user', content: 'Use tool list_dir with path C:\\' }],
        tools: [{ type: 'function', function: { name: 'list_dir', description: 'list files',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }],
      }, { signVariant: 'v3' });
      if (r2.status === 200) {
        const j = JSON.parse(r2.text);
        row.tools = (j.choices[0].message.tool_calls && j.choices[0].message.tool_calls.length) ? 'Y' : 'n';
        row.finish = j.choices[0].finish_reason;
      } else {
        row.tools = 'HTTP' + r2.status;
      }
    } catch (e) { row.tools = 'ERR'; }

    console.log('%-16s %6s %8s %8s %6s %6s %s',
      row.m, row.http, row.sec, row.in, row.out, row.reason, row.tools + (row.finish ? ' (' + row.finish + ')' : ''));
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
