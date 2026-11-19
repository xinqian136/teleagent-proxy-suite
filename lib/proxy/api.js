'use strict';
/**
 * proxy/api.js — OpenAI / Anthropic / Responses 协议转换
 *
 * 对外暴露：
 *   POST /v1/chat/completions      OpenAI Chat Completions
 *   POST /v1/messages              Anthropic Messages
 *   POST /v1/responses             OpenAI Responses
 *   GET  /v1/models                模型列表
 *   GET  /health                   健康检查
 *
 * ★ 关键原则：content 数组**原样保留**。
 *   只保留 type==='text' 会丢掉 tool_result / image / input_file 等块，
 *   工具循环断裂 → 模型失忆 → 行为异常。
 */

const MODELS = [
  'chat-flagship',
  'chat-pro',
  'chat-lite',
  'chat-flash',
  'chat-nano',
];

/** 透传字段：客户端给了就原样带给网关 */
const PASSTHROUGH = [
  'tools', 'tool_choice', 'parallel_tool_calls', 'max_tokens', 'max_completion_tokens',
  'temperature', 'top_p', 'top_k', 'stop', 'seed', 'n', 'presence_penalty',
  'frequency_penalty', 'logprobs', 'top_logprobs', 'response_format',
  'reasoning_effort', 'modalities', 'user', 'metadata', 'logit_bias',
  'min_p', 'top_a', 'include_reasoning', 'thinking', 'service_tier',
  'safety_identifier', 'prompt_cache_key', 'verbosity',
];

/** OpenAI 请求 → 网关请求体 */
function openaiToGateway(body) {
  const out = {
    model: body.model || 'chat-flagship',
    messages: normalizeMessages(body.messages || []),
  };
  // ★ stream 由调用方决定，这里不写死
  for (const k of PASSTHROUGH) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

/**
 * 统一消息格式
 * - content 是字符串 → 原样
 * - content 是数组 → **原样保留**（多模态块、tool_result 块都不能丢）
 * - role==='tool' → 保留 tool_call_id（网关要靠它匹配工具调用）
 */
function normalizeMessages(msgs) {
  return msgs.map((m) => {
    const out = { role: m.role };
    if (m.content !== undefined && m.content !== null) out.content = m.content;
    else out.content = '';
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.name) out.name = m.name;
    if (m.refusal) out.refusal = m.refusal;
    if (m.function_call) out.function_call = m.function_call;
    return out;
  });
}

/** Anthropic 请求 → 网关请求体 */
function anthropicToGateway(body) {
  const msgs = [];
  if (body.system) {
    const sys = typeof body.system === 'string'
      ? body.system
      : (Array.isArray(body.system) ? body.system.map((b) => b.text || '').join('\n') : JSON.stringify(body.system));
    msgs.push({ role: 'system', content: sys });
  }
  for (const m of body.messages || []) {
    // ★ content 原样保留 —— tool_result 块绝对不能丢
    msgs.push(normalizeMessages([m])[0]);
  }
  const out = {
    model: body.model || 'chat-flagship',
    messages: msgs,
  };
  for (const k of PASSTHROUGH) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  if (body.max_tokens !== undefined) out.max_tokens = body.max_tokens;
  if (body.stop_sequences && !out.stop) out.stop = body.stop_sequences;
  return out;
}

/**
 * Responses API → 网关请求体
 *
 * ★ 这套协议的字段是 `input`（不是 messages），`instructions` 是 system。
 *   漏掉 input 就会给网关发一个空消息列表 —— 模型完全不知道上下文。
 */
function responsesToGateway(body) {
  const msgs = [];
  if (body.instructions) {
    msgs.push({ role: 'system', content: body.instructions });
  }
  const input = body.input;
  if (typeof input === 'string') {
    msgs.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') { msgs.push({ role: 'user', content: item }); continue; }
      const role = item.role || 'user';
      let content = item.content;
      // Responses 的 input 块用 input_text / input_image / input_file
      if (Array.isArray(content)) {
        content = content.map((p) => {
          if (p.type === 'input_text') return { type: 'text', text: p.text };
          if (p.type === 'input_image') {
            return { type: 'image_url', image_url: { url: p.image_url } };
          }
          return p;   // 其它块原样
        });
      }
      const rec = { role, content };
      if (item.tool_call_id) rec.tool_call_id = item.tool_call_id;
      if (item.name) rec.name = item.name;
      if (item.call_id) rec.tool_call_id = item.call_id;
      msgs.push(rec);
    }
  }

  const out = {
    model: body.model || 'chat-flagship',
    messages: msgs,
  };
  for (const k of PASSTHROUGH) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  // Responses 的 tools 格式与 OpenAI 略有差异
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => {
      if (t.type === 'function' && t.function) return t;
      if (t.type === 'function' && t.name) {
        return {
          type: 'function',
          function: {
            name: t.name,
            description: t.description || '',
            parameters: t.parameters || { type: 'object', properties: {} },
          },
        };
      }
      if (t.type === 'function' && t.flat) {
        return {
          type: 'function',
          function: {
            name: t.flat.name,
            description: t.flat.description || '',
            parameters: t.flat.parameters || { type: 'object', properties: {} },
          },
        };
      }
      return t;
    });
  }
  return out;
}

/** 网关响应 → OpenAI 响应 */
function gatewayToOpenai(gw, reqModel) {
  const choice = gw.choices?.[0] || {};
  const msg = choice.message || {};
  const message = { role: 'assistant', content: msg.content ?? '' };
  if (msg.reasoning_content) message.reasoning_content = msg.reasoning_content;
  if (msg.reasoning) message.reasoning = msg.reasoning;
  if (msg.tool_calls && msg.tool_calls.length) {
    message.tool_calls = msg.tool_calls.map((t) => ({
      id: t.id,
      type: 'function',
      function: { name: t.function?.name, arguments: t.function?.arguments || '{}' },
    }));
    message.content = msg.content ?? null;
  }
  const out = {
    id: 'chatcmpl-' + Date.now().toString(36),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: reqModel || gw.model || 'chat-flagship',
    choices: [{
      index: 0,
      message,
      finish_reason: choice.finish_reason || (message.tool_calls ? 'tool_calls' : 'stop'),
    }],
  };
  if (gw.usage) out.usage = gw.usage;
  else out.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return out;
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
  MODELS, PASSTHROUGH,
  openaiToGateway, anthropicToGateway, responsesToGateway, normalizeMessages,
  gatewayToOpenai, gatewayToAnthropic, gatewayToResponses,
  extractError,
};
