'use strict';
/**
 * proxy/sse.js — SSE 流式工具
 *
 * 网关返回的是 OpenAI 格式的 SSE（data: {choices:[{delta:{content}}]}）。
 * 客户端可能要求 OpenAI 格式（直接透传）或 Anthropic 格式（要转换）。
 *
 * 提供：
 *   pipeRaw(res, webStream)              原始字节透传（OpenAI 路径，最保真）
 *   readSse(webStream)                    解析成 {event, data} 序列
 *   openaiToAnthropicStream(res, src, opts)  网关 SSE → Anthropic 事件流
 */

/** 原始字节透传（OpenAI / Responses 路径） */
async function pipeRaw(res, webStream, headers = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...headers,
  });
  if (!webStream) { res.end(); return; }
  const reader = webStream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
      // 立刻刷出去，不要攒着
      if (res.flush) res.flush();
    }
  } catch (e) {
    try { res.write(`data: {"error":{"message":"${String(e.message).replace(/"/g, '\\"')}"}}\n\n`); } catch (_) {}
  }
  res.end();
}

/**
 * 解析 SSE 流 → async generator，产出 {event, data}
 */
async function* readSse(webStream) {
  if (!webStream) return;
  const reader = webStream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const parsed = parseBlock(chunk);
      if (parsed) yield parsed;
    }
  }
  if (buf.trim()) {
    const parsed = parseBlock(buf);
    if (parsed) yield parsed;
  }
}

function parseBlock(block) {
  let event = null;
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  const data = dataLines.join('\n');
  if (data === '[DONE]') return { event, data, done: true };
  let json = null;
  try { json = JSON.parse(data); } catch (_) {}
  return { event, data, json };
}

/**
 * 网关 OpenAI SSE → Anthropic 事件流
 *
 * Anthropic 事件顺序：
 *   message_start → content_block_start → content_block_delta* → content_block_stop → message_delta → message_stop
 */
async function openaiToAnthropicStream(res, webStream, opts = {}) {
  const id = 'msg_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const model = opts.model || 'chat-flash';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event, data) => {
    res.write('event: ' + event + '\n');
    res.write('data: ' + JSON.stringify(data) + '\n\n');
    if (res.flush) res.flush();
  };

  send('message_start', {
    type: 'message_start',
    message: {
      id, type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  send('content_block_start', {
    type: 'content_block_start', index: 0,
    content_block: { type: 'text', text: '' },
  });

  let textStarted = false;
  let toolIndex = -1;
  let toolBlocks = [];       // 已发出的 tool_use 块
  let stopReason = 'end_turn';
  let usage = { input_tokens: 0, output_tokens: 0 };

  const startToolBlock = (id_, name) => {
    toolIndex += 1;
    toolBlocks.push({ index: toolIndex, id: id_, name });
    send('content_block_start', {
      type: 'content_block_start', index: toolIndex,
      content_block: { type: 'tool_use', id: id_, name, input: {} },
    });
    return toolIndex;
  };

  for await (const ev of readSse(webStream)) {
    if (ev.done) break;
    const j = ev.json;
    if (!j) continue;

    if (j.usage) {
      usage = {
        input_tokens: j.usage.prompt_tokens || usage.input_tokens,
        output_tokens: j.usage.completion_tokens || usage.output_tokens,
      };
    }

    const choice = j.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};

    // 文本增量
    if (typeof delta.content === 'string' && delta.content.length) {
      if (!textStarted) { textStarted = true; }
      send('content_block_delta', {
        type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: delta.content },
      });
    }

    // 思考内容（Anthropic 用 thinking 块）
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) {
      send('content_block_delta', {
        type: 'content_block_delta', index: 0,
        delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
      });
    }

    // 工具调用增量
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let blk = toolBlocks.find((b) => b.index === idx);
        if (!blk) {
          const fn = tc.function || {};
          const idx2 = startToolBlock(tc.id || 'call_' + idx, fn.name || '');
          blk = toolBlocks.find((b) => b.index === idx2);
          blk.rawArgs = '';
        }
        if (tc.id && !blk.id) blk.id = tc.id;
        if (tc.function && tc.function.name && !blk.name) blk.name = tc.function.name;
        const args = tc.function && tc.function.arguments;
        if (args) {
          blk.rawArgs += args;
          send('content_block_delta', {
            type: 'content_block_delta', index: blk.index,
            delta: { type: 'input_json_delta', partial_json: args },
          });
        }
      }
    }

    if (choice.finish_reason) {
      if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') stopReason = 'tool_use';
      else if (choice.finish_reason === 'length') stopReason = 'max_tokens';
      else stopReason = 'end_turn';
    }
  }

  // 关闭所有块
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  for (const b of toolBlocks) {
    send('content_block_stop', { type: 'content_block_stop', index: b.index });
  }

  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: usage,
  });
  send('message_stop', { type: 'message_stop' });

  res.end();
}

module.exports = { pipeRaw, readSse, openaiToAnthropicStream, parseBlock };
