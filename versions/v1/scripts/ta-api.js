/**
 * ta-api.js — API 层：路由、鉴权、CORS、OpenAI + Anthropic 协议转换。
 *
 * 单独成文件，方便 ta-shim.js 只管内核交互。
 */
const crypto = require('crypto');

/** 从请求头里取 API Key（兼容 OpenAI 的 Authorization: Bearer 与 Anthropic 的 x-api-key） */
function extractApiKey(req) {
  const auth = String(req.headers['authorization'] || '');
  const bearer = auth.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;
  const xk = String(req.headers['x-api-key'] || '').trim();
  if (xk) return xk;
  const q = String(req.headers['x-goog-api-key'] || '').trim();
  return q || '';
}

/** 鉴权：apiKey 为空则不校验 */
function checkAuth(req, apiKey) {
  if (!apiKey) return { ok: true };
  const given = extractApiKey(req);
  if (!given) {
    return { ok: false, status: 401, body: { error: { message: 'Missing API key', type: 'invalid_request_error' } } };
  }
  // 定长比较，避免时序侧信道
  const a = Buffer.from(given);
  const b = Buffer.from(apiKey);
  const same = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!same) {
    return { ok: false, status: 401, body: { error: { message: 'Invalid API key', type: 'invalid_request_error' } } };
  }
  return { ok: true };
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, x-goog-api-key',
  'Access-Control-Max-Age': '86400',
};

/** OpenAI 风格错误体 */
function openaiError(message, type = 'invalid_request_error', code = null) {
  return { error: { message, type, ...(code ? { code } : {}) } };
}

/** Anthropic 风格错误体 */
function anthropicError(message, type = 'invalid_request_error') {
  return { type: 'error', error: { type, message } };
}

/**
 * Anthropic Messages API 响应体
 * @param {object} result  chatCompletion 的结果
 */
function anthropicResponse(result, model) {
  const u = result.usage || {};
  return {
    id: 'msg_' + crypto.randomBytes(12).toString('hex'),
    type: 'message',
    role: 'assistant',
    model: model || 'chat-pro',
    content: [{ type: 'text', text: result.text || '' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: u.input || 0,
      output_tokens: u.output || 0,
    },
  };
}

/** Anthropic SSE 事件流 */
function anthropicSse(res, result, model) {
  const id = 'msg_' + crypto.randomBytes(12).toString('hex');
  const created = Math.floor(Date.now() / 1000);
  const send = (event, data) => {
    res.write('event: ' + event + '\n');
    res.write('data: ' + JSON.stringify(data) + '\n\n');
  };
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    ...CORS_HEADERS,
  });
  send('message_start', {
    type: 'message_start',
    message: {
      id, type: 'message', role: 'assistant', model: model || 'chat-pro',
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: (result.usage && result.usage.input) || 0, output_tokens: 0 },
    },
  });
  send('content_block_start', {
    type: 'content_block_start', index: 0,
    content_block: { type: 'text', text: '' },
  });
  const text = result.text || '';
  for (let i = 0; i < text.length; i += 24) {
    send('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: text.slice(i, i + 24) },
    });
  }
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: (result.usage && result.usage.output) || 0 },
  });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

/**
 * Anthropic Messages 请求体 → shim 内部 chatCompletion 的 body
 * Anthropic 的 system 是顶层字段，messages 里 role 是 user/assistant
 */
function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    messages.push({ role: 'system', content: typeof body.system === 'string' ? body.system : JSON.stringify(body.system) });
  }
  for (const m of (body.messages || [])) {
    messages.push({ role: m.role, content: m.content });
  }
  return {
    model: body.model,
    messages,
    stream: body.stream,
    // Anthropic 的 max_tokens 是必填，转成 OpenAI 语义（内核忽略）
    max_tokens: body.max_tokens,
  };
}

/**
 * OpenAI Responses API（/v1/responses）请求体 → chatCompletion body
 * 这套协议的 input 是数组形式
 */
function responsesToOpenAI(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });
  for (const item of (body.input || [])) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item });
      continue;
    }
    const role = item.role || 'user';
    let content = item.content;
    if (Array.isArray(content)) {
      content = content.map(c => {
        if (typeof c === 'string') return c;
        if (c && c.type === 'input_text') return c.text || '';
        if (c && c.type === 'output_text') return c.text || '';
        return '';
      }).join('');
    }
    messages.push({ role, content: content == null ? '' : content });
  }
  return { model: body.model, messages, stream: body.stream };
}

/** OpenAI Responses API 响应体 */
function responsesResponse(result, model) {
  const u = result.usage || {};
  const text = result.text || '';
  return {
    id: 'resp_' + crypto.randomBytes(12).toString('hex'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: model || 'chat-pro',
    output: [{
      id: 'msg_' + crypto.randomBytes(8).toString('hex'),
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    }],
    output_text: text,
    usage: {
      input_tokens: u.input || 0,
      output_tokens: u.output || 0,
      total_tokens: (u.input || 0) + (u.output || 0),
    },
  };
}

module.exports = {
  extractApiKey, checkAuth, CORS_HEADERS,
  openaiError, anthropicError,
  anthropicResponse, anthropicSse, anthropicToOpenAI,
  responsesToOpenAI, responsesResponse,
};
