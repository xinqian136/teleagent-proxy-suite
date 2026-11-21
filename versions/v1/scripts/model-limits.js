#!/usr/bin/env node
/**
 * model-limits.js — 实测 max_tokens 上限行为。
 */
const { getToken } = require('./ta-token');
const { chatCompletion } = require('./ta-gateway');

(async () => {
  const { token } = getToken();

  // 1) max_tokens 超过声明上限会怎样
  console.log('=== max_tokens 边界 (chat-pro, 声明 out=65536) ===');
  for (const mt of [16384, 65536, 131072, 999999]) {
    const r = await chatCompletion({
      model: 'chat-pro',
      messages: [{ role: 'user', content: '数到 100' }],
      max_tokens: mt,
      stream: false,
    }, { signVariant: 'v3' });
    if (r.status === 200) {
      const j = JSON.parse(r.text);
      console.log('  max_tokens=%-8s -> 200  out_tokens=%s  finish=%s',
        mt, j.usage.completion_tokens, j.choices[0].finish_reason);
    } else {
      console.log('  max_tokens=%-8s -> %s %s', mt, r.status, r.text.slice(0, 150));
    }
  }

  // 2) temperature 是否被接受（capabilities 说 temperature: false）
  console.log('\n=== temperature / top_p 透传 ===');
  for (const extra of [{}, { temperature: 0.7 }, { temperature: 0.7, top_p: 0.9 }, { max_tokens: 100, temperature: 0.2 }]) {
    const r = await chatCompletion(Object.assign({
      model: 'chat-flash',
      messages: [{ role: 'user', content: 'Say OK' }],
      stream: false,
    }, extra), { signVariant: 'v3' });
    if (r.status === 200) {
      const j = JSON.parse(r.text);
      console.log('  %-40s -> 200  out=%s', JSON.stringify(extra), j.usage.completion_tokens);
    } else {
      console.log('  %-40s -> %s %s', JSON.stringify(extra), r.status, r.text.slice(0, 120));
    }
  }

  // 3) 长上下文探测：灌 ~50k token 看是否正常
  console.log('\n=== 长上下文 (chat-pro, 声明 ctx=1000000) ===');
  const filler = '数据行。'.repeat(8000);   // ~每个字算1 token 的话约 32k token
  const t = Date.now();
  const r = await chatCompletion({
    model: 'chat-pro',
    messages: [
      { role: 'user', content: filler },
      { role: 'assistant', content: '收到。' },
      { role: 'user', content: '上面那段数据有多少行？只答数字。' },
    ],
    stream: false,
  }, { signVariant: 'v3' });
  const sec = ((Date.now() - t) / 1000).toFixed(1);
  if (r.status === 200) {
    const j = JSON.parse(r.text);
    console.log('  灌入 ~32k token -> 200  耗时 %ss  in=%s  out=%s', sec,
      j.usage.prompt_tokens, j.usage.completion_tokens);
    console.log('  回答:', (j.choices[0].message.content || '').slice(0, 120));
  } else {
    console.log('  灌入 ~32k token -> %s %s  耗时 %ss', r.status, r.text.slice(0, 200), sec);
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
