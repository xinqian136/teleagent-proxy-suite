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

/**
 * 模型别名映射
 *
 * 网关的模型路由是动态的：同一个模型名，有时支持视觉、有时被路由到只支持
 * 文本的后端（表现为 400 "only supports text input"，或者 200 但模型答
 * "我无法查看图片"）。靠检测错误再降级不可靠 —— 报错形式会变。
 *
 * 所以这里提供显式别名：
 *   chat-flagshipAuto → 带图用 chat-flash（视觉稳定），纯文本用 chat-flagship
 *
 * 客户端在模型下拉里选 chat-flagshipAuto 就行，不用关心网关当天怎么路由。
 */
const MODEL_ALIASES = {
  'chat-flagshipAuto': {
    real: 'chat-flagship',        // 纯文本用旗舰
    vision: 'chat-flash',         // 带图用视觉稳定的
    desc: '自动：带图走 chat-flash，纯文本走 chat-flagship',
  },
};

/**
 * 解析模型别名 → 实际要发给网关的模型名
 * @param {string} model       客户端请求的模型名
 * @param {boolean} hasImage   请求里有没有图片
 * @param {object} [overrides] 用户覆盖配置 { visionModel: 'chat-lite' }
 * @returns {{name:string, aliased:boolean, switched:boolean}}
 */
function resolveModel(model, hasImage, overrides) {
  const alias = MODEL_ALIASES[model];
  if (!alias) return { name: model, aliased: false, switched: false };

  let target = alias.real;
  if (hasImage) {
    // 用户可以指定用哪个模型处理图片
    const visionModel = (overrides && overrides.visionModel) || alias.vision;
    target = visionModel || alias.real;
  }
  return { name: target, aliased: true, switched: target !== alias.real };
}

/** 带别名的模型列表（给 /v1/models 用） */
function modelList(overrides) {
  const base = MODELS.map((id) => ({ id }));
  const aliases = Object.keys(MODEL_ALIASES).map((id) => ({
    id,
    alias: true,
    desc: MODEL_ALIASES[id].desc,
    vision_model: (overrides && overrides.visionModel) || MODEL_ALIASES[id].vision,
  }));
  return base.concat(aliases);
}

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

/**
 * Anthropic 请求 → 网关请求体
 *
 * ★ 网关只认 OpenAI 格式的块，Anthropic 的块必须转换：
 *     image      → image_url (base64 data URL)
 *     tool_use   → assistant.tool_calls
 *     tool_result→ role:'tool' 消息
 *     document   → 降级成文本说明（网关不支持文件输入）
 *     thinking   → 丢弃（网关不认）
 *
 *   不转换的话网关直接报 1214「type类型错误」。
 *   实测：网关只支持 text + image_url(base64 data URL) 两种输入。
 */
function anthropicToGateway(body) {
  const msgs = [];
  if (body.system) {
    msgs.push({ role: 'system', content: systemToText(body.system) });
  }
  for (const m of body.messages || []) {
    msgs.push(...convertAnthropicMessage(m));
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

function systemToText(sys) {
  if (typeof sys === 'string') return sys;
  if (Array.isArray(sys)) return sys.map((b) => b.text || '').join('\n');
  return JSON.stringify(sys);
}

/** Anthropic source → data URL（网关只吃 base64 data URL） */
function anthropicImageToDataUrl(source) {
  if (!source) return null;
  if (source.type === 'base64') {
    if (!source.data) return null;
    return `data:${source.media_type || 'image/png'};base64,${source.data}`;
  }
  if (source.type === 'url' && source.url) return source.url;
  if (source.data && source.media_type) {
    return `data:${source.media_type};base64,${source.data}`;
  }
  return null;
}

/** Anthropic document source → 文本（网关不支持文件输入，只能降级） */
function anthropicDocumentToText(source) {
  if (!source) return null;
  if (source.type === 'text' && source.data) return source.data;
  if (source.data && source.media_type && source.media_type.startsWith('text/')) {
    try { return Buffer.from(source.data, 'base64').toString('utf8'); } catch (_) {}
  }
  const mt = source.media_type || '未知类型';
  const name = source.filename || source.url || '附件';
  return `[文档附件：${name}（${mt}）—— 该反代网关暂不支持直接解析文件，请改用文件读取工具获取内容]`;
}

/** tool_result 的 content → 字符串（OpenAI 的 tool 消息只收字符串） */
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (typeof c === 'string') return c;
      if (c.type === 'text') return c.text || '';
      if (c.type === 'image') return '[工具返回了图片，网关暂不支持]';
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content === null || content === undefined) return '';
  return JSON.stringify(content);
}

/**
 * 一条 Anthropic 消息 → 0..n 条 OpenAI 消息
 *
 * Anthropic 把「工具调用」放在 assistant 的 content 块里，
 * 把「工具结果」放在 user 的 content 块里；
 * OpenAI 分别是 assistant.tool_calls 和 role:'tool' 消息。
 */
function convertAnthropicMessage(m) {
  const role = m.role === 'assistant' ? 'assistant' : 'user';
  const content = m.content;

  if (typeof content === 'string') return [{ role, content }];
  if (!Array.isArray(content)) return [{ role, content: content ?? '' }];

  const textParts = [];
  const mediaParts = [];
  const toolCalls = [];
  const toolResults = [];

  for (const b of content) {
    if (!b || typeof b !== 'object') {
      if (typeof b === 'string') textParts.push(b);
      continue;
    }
    switch (b.type) {
      case 'text':
        textParts.push(b.text || '');
        break;
      case 'image': {
        const u = anthropicImageToDataUrl(b.source);
        if (u) mediaParts.push({ type: 'image_url', image_url: { url: u } });
        else textParts.push('[图片无法解析：缺少 source]');
        break;
      }
      case 'document': {
        const t = anthropicDocumentToText(b.source);
        if (t) textParts.push(t);
        break;
      }
      case 'tool_use':
        toolCalls.push({
          id: b.id || 'call_' + Math.random().toString(36).slice(2, 10),
          type: 'function',
          function: {
            name: b.name || 'tool',
            arguments: JSON.stringify(b.input || {}),
          },
        });
        break;
      case 'tool_result':
        toolResults.push({
          role: 'tool',
          tool_call_id: b.tool_use_id || b.id || 'call_unknown',
          content: toolResultText(b.content),
        });
        break;
      case 'thinking':
        // 网关不认 thinking 块，丢弃
        break;
      default:
        if (b.text) textParts.push(b.text);
        else if (b.type) textParts.push(`[${b.type} 块已忽略]`);
        break;
    }
  }

  const out = [];
  // 工具结果先于同一条消息的文本（对应 OpenAI 的 tool → user 顺序）
  out.push(...toolResults);

  const text = textParts.join('\n');
  if (mediaParts.length) {
    // 有图 → content 用数组，文本块在前
    out.push({ role, content: [{ type: 'text', text }, ...mediaParts] });
  } else {
    const rec = { role, content: text };
    if (toolCalls.length) rec.tool_calls = toolCalls;
    out.push(rec);
  }
  // assistant 带 tool_use 时，content 单独一条，tool_calls 挂在上面那条
  if (toolCalls.length && mediaParts.length) {
    out[out.length - 1].tool_calls = toolCalls;
  }
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
            // image_url 可能是字符串，也可能是 {url}
            const u = typeof p.image_url === 'string' ? p.image_url : (p.image_url && p.image_url.url);
            return u ? { type: 'image_url', image_url: { url: u } } : p;
          }
          if (p.type === 'input_file') {
            // 网关不支持文件输入，降级成文本说明
            const name = p.filename || p.file_id || '附件';
            return { type: 'text', text: `[文件附件：${name} —— 该反代网关暂不支持直接解析文件，请改用文件读取工具获取内容]` };
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
  MODELS, PASSTHROUGH, MODEL_ALIASES,
  openaiToGateway, anthropicToGateway, responsesToGateway, normalizeMessages,
  gatewayToOpenai, gatewayToAnthropic, gatewayToResponses,
  extractError, resolveModel, modelList,
};
