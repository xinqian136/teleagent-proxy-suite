'use strict';
/**
 * proxy/api.js — OpenAI / Anthropic 协议转换
 *
 * 对外暴露：
 *   POST /v1/chat/completions      OpenAI Chat Completions
 *   POST /v1/messages              Anthropic Messages
 *   POST /v1/responses             OpenAI Responses
 *   GET  /v1/models                模型列表
 *   GET  /health                   健康检查
 *
 * 全部转成网关的 chat/completions 格式，拿到结果再转回对应协议。
 */

const MODELS = [
  'chat-flagship',
  'chat-pro',
  'chat-lite',
  'chat-flash',
  'chat-nano',
];

/** OpenAI 请求 → 网关请求体 */
function openaiToGateway(body) {
  const out = {
    model: body.model || 'chat-flagship',
    messages: normalizeMessages(body.messages || []),
    stream: false,
  };
  if (body.tools && body.tools.length) out.tools = body.tools;
  if (body.tool_choice) out.tool_choice = body.tool_choice;
  if (body.max_tokens || body.max_completion_tokens) {
    out.max_tokens = body.max_tokens || body.max_completion_tokens;
  }
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.reasoning_effort) out.reasoning_effort = body.reasoning_effort;
  if (body.stop) out.stop = body.stop;
  return out;
}

/** 统一消息格式（兼容 content 为数组的多模态写法） */
function normalizeMessages(msgs) {
  return msgs.map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    if (Array.isArray(m.content)) {
      const text = m.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('');
      return { role: m.role, content: text };
    }
    return { role: m.role, content: m.content ?? '' };
  });
}

/** Anthropic 请求 → 网关请求体 */
function anthropicToGateway(body) {
  const msgs = [];
  if (body.system) {
    const sys = typeof body.system === 'string'
      ? body.system
      : (body.system || []).map((b) => b.text || '').join('\n');
    msgs.push({ role: 'system', content: sys });
  }
  for (const m of body.messages || []) {
    const content = Array.isArray(m.content)
      ? m.content.filter((c) => c.type === 'text').map((c) => c.text).join('')
      : m.content;
    msgs.push({ role: m.role, content });
  }
  const out = {
    model: body.model || 'chat-flagship',
    messages: msgs,
    stream: false,
  };
  if (body.tools && body.tools.length) {
    // Anthropic 的工具定义 → OpenAI 的 function 形式
    out.tools = body.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  }
  if (body.max_tokens) out.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop_sequences) out.stop = body.stop_sequences;
  if (body.thinking && body.thinking.budget_tokens) {
    out.reasoning_effort = 'medium';
  }
  return out;
}

/** 网关响应 → OpenAI 响应 */
function gatewayToOpenai(gw, reqModel) {
  const choice = gw.choices?.[0] || {};
  const msg = choice.message || {};
  const message = { role: 'assistant', content: msg.content ?? '' };
  if (msg.reasoning_content) message.reasoning_content = msg.reasoning_content;
  if (msg.tool_calls && msg.tool_calls.length) {
    message.tool_calls = msg.tool_calls.map((t) => ({
      id: t.id,
      type: 'function',
      function: { name: t.function?.name, arguments: t.function?.arguments || '{}' },
    }));
    message.content = msg.content ?? null;
  }
  return {
    id: 'chatcmpl-' + Date.now().toString(36),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: reqModel || gw.model || 'chat-flagship',
    choices: [{
      index: 0,
      message,
      finish_reason: choice.finish_reason || (message.tool_calls ? 'tool_calls' : 'stop'),
    }],
    usage: gw.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** 网关响应 → Anthropic 响应 */
function gatewayToAnthropic(gw, reqModel) {
  const choice = gw.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.reasoning_content) {
    content.push({ type: 'thinking', thinking: msg.reasoning_content });
  }
  if (msg.tool_calls && msg.tool_calls.length) {
    for (const t of msg.tool_calls) {
      content.push({
        type: 'tool_use',
        id: t.id,
        name: t.function?.name,
        input: safeParse(t.function?.arguments),
      });
    }
  } else {
    content.push({ type: 'text', text: msg.content ?? '' });
  }
  const u = gw.usage || {};
  return {
    id: 'msg_' + Date.now().toString(36),
    type: 'message',
    role: 'assistant',
    model: reqModel || gw.model || 'chat-flagship',
    content,
    stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    usage: {
      input_tokens: u.prompt_tokens || 0,
      output_tokens: u.completion_tokens || 0,
    },
  };
}

/** 网关响应 → Responses 格式 */
function gatewayToResponses(gw, reqModel) {
  const choice = gw.choices?.[0] || {};
  const msg = choice.message || {};
  const out = [];
  if (msg.reasoning_content) {
    out.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: msg.reasoning_content }] });
  }
  if (msg.tool_calls && msg.tool_calls.length) {
    for (const t of msg.tool_calls) {
      out.push({
        type: 'function_call',
        call_id: t.id,
        name: t.function?.name,
        arguments: t.function?.arguments || '{}',
      });
    }
  } else {
    out.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: msg.content ?? '' }] });
  }
  const u = gw.usage || {};
  return {
    id: 'resp_' + Date.now().toString(36),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: reqModel || gw.model || 'chat-flagship',
    output: out,
    status: 'completed',
    usage: {
      input_tokens: u.prompt_tokens || 0,
      output_tokens: u.completion_tokens || 0,
      total_tokens: u.total_tokens || 0,
    },
  };
}

function safeParse(s) {
  try { return JSON.parse(s || '{}'); } catch (_) { return {}; }
}

/** 从网关错误响应里提取错误码 */
function extractError(text, status) {
  try {
    const j = JSON.parse(text);
    return {
      code: j.code || j.error?.code || status,
      message: j.message || j.error?.message || text.slice(0, 200),
    };
  } catch (_) {
    return { code: status, message: text.slice(0, 200) };
  }
}

module.exports = {
  MODELS,
  openaiToGateway, anthropicToGateway, normalizeMessages,
  gatewayToOpenai, gatewayToAnthropic, gatewayToResponses,
  extractError,
};
