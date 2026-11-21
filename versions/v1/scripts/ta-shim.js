#!/usr/bin/env node
/**
 * ta-shim.js — TeleAgent 本地反代（方案 B：走 App 本地内核 server）
 *
 *   你的工具 → 本 shim (127.0.0.1:8788, OpenAI 兼容协议)
 *            → TeleAgent 内核 (127.0.0.1:4397, OpenCode 风格)
 *            → 云网关（由 App 进程发出，流量特征与真人用 App 一致）
 *
 * 特性：
 *   - /v1/models、/v1/chat/completions（支持 stream）
 *   - sessionKey 自动获取 + 401 时自动重取重试（App 重启后 key 会变）
 *   - 多轮对话：按历史消息哈希映射到同一个内核会话
 *   - 内核自带工具（bash / 文件 / 生图 / 搜索 / MCP）自动生效
 *
 * 用法：
 *   node ta-shim.js
 *   TA_PORT=9000 node ta-shim.js
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = process.env.USERPROFILE || process.env.HOME || '.';
const CONFIG = {
  port: Number(process.env.TA_PORT || 8788),
  // 监听地址：默认只听本机；设 TA_HOST=0.0.0.0 可对外（局域网）暴露
  host: process.env.TA_HOST || '127.0.0.1',
  // API Key：为空则不校验。设 TA_API_KEY 后客户端必须带 Authorization: Bearer <key>
  apiKey: process.env.TA_API_KEY || '',
  kernel: process.env.TA_KERNEL_URL || 'http://127.0.0.1:4397',
  providerID: process.env.TA_PROVIDER_ID || 'NewApi',
  models: ['chat-pro', 'chat-lite', 'chat-flash', 'chat-flagship', 'chat-nano'],
  // 内核 agent loop 的执行模式：yolo=全自动执行工具（无人值守）
  mode: process.env.TA_MODE || 'yolo',
  // 指定内核 agent 定义（空=用内核默认）
  agent: process.env.TA_AGENT || '',
  // 是否拉取会话历史以收集工具调用明细（agent 场景需要）
  collectTools: process.env.TA_COLLECT_TOOLS !== '0',
  dir: __dirname,
};
const keyFile = path.join(CONFIG.dir, 'session.key');
const pythonPath = path.join(HOME, '.local', 'share', 'TeleAgent', 'runtimes', 'python', 'python.exe');

// ===================== sessionKey 管理 =====================
let sessionKey = null;
let keyMtime = 0;

function readKeyFile() {
  try {
    const k = fs.readFileSync(keyFile, 'utf8').trim();
    if (k && k.length >= 40) {
      try { keyMtime = fs.statSync(keyFile).mtimeMs; } catch (_) {}
      return k;
    }
  } catch (_) {}
  return null;
}

function fetchKeyByScan() {
  const script = path.join(CONFIG.dir, 'find-sessionkey.py');
  if (!fs.existsSync(script)) return null;
  try {
    const out = execFileSync(pythonPath, [script], { encoding: 'utf8', timeout: 900000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /sessionKey=([A-Za-z0-9_\-]{43})/.exec(out || '');
    if (m) {
      fs.writeFileSync(keyFile, m[1]);
      keyMtime = Date.now();
      return m[1];
    }
  } catch (_) {}
  return null;
}

function getKey(force) {
  if (process.env.TA_SESSION_KEY) return process.env.TA_SESSION_KEY;
  if (!force && sessionKey) return sessionKey;
  if (!force) {
    const k = readKeyFile();
    if (k) { sessionKey = k; return k; }
  }
  // force=true：App 可能已重启，缓存和文件里的 key 都过期了，必须重新扫内存
  const k = fetchKeyByScan();
  if (k) { sessionKey = k; return k; }
  if (!force) {
    const k2 = readKeyFile();
    if (k2) { sessionKey = k2; return k2; }
  }
  sessionKey = null;
  return null;
}

// ===================== 内核调用 =====================
function signHeaders(method, pathWithQuery, key) {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(12).toString('hex');
  const payload = ['local-v1', method.toUpperCase(), pathWithQuery, ts, nonce].join('\n');
  const signature = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  return {
    'X-SA-Sign-Version': 'local-v1',
    'X-SA-Timestamp': ts,
    'X-SA-Nonce': nonce,
    'X-SA-Signature': signature,
  };
}

async function kernelCall(method, urlPath, body, retry = true, timeoutMs = 300000) {
  const key = getKey();
  if (!key) throw new Error('缺少 sessionKey：先运行 find-sessionkey.py 或设 TA_SESSION_KEY');
  const headers = signHeaders(method, urlPath, key);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(CONFIG.kernel + urlPath, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ac.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    if ((r.status === 401 || r.status === 403) && retry) {
      console.error('[shim] 401/403，重新获取 sessionKey 后重试');
      const nk = getKey(true);
      if (nk && nk !== key) return kernelCall(method, urlPath, body, false, timeoutMs);
      throw new Error('sessionKey 失效且无法自动刷新（App 可能未运行/未登录）: ' + text.slice(0, 200));
    }
    return { status: r.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

// ===================== 会话映射 =====================
const sessionMap = new Map();   // historyHash -> sessionId
const H = (arr) => crypto.createHash('sha1').update(JSON.stringify(arr)).digest('hex');

function splitMessages(messages) {
  const sys = messages.filter(m => m.role === 'system' || m.role === 'developer')
    .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n\n');
  const rest = messages.filter(m => m.role !== 'system' && m.role !== 'developer');
  const last = rest[rest.length - 1];
  return { sys, last, prefix: rest.slice(0, -1), rest };
}

async function ensureSession(prefix) {
  const h = H(prefix);
  if (prefix.length && sessionMap.has(h)) return sessionMap.get(h);
  const r = await kernelCall('POST', '/session', { title: 'openai-shim' });
  if (r.status !== 200 || !r.json) throw new Error('创建内核会话失败(' + r.status + '): ' + r.text.slice(0, 300));
  const id = (r.json.data && r.json.data.id) || r.json.id;
  if (!id) throw new Error('内核会话无 id: ' + r.text.slice(0, 200));
  return id;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => (typeof p === 'string' ? p : (p.text || ''))).join('');
  return '';
}

// ===================== 对话 =====================
async function chatCompletion(body) {
  const messages = body.messages || [];
  const { sys, last, prefix, rest } = splitMessages(messages);
  if (!last) throw new Error('请求里没有用户消息');

  const modelID = CONFIG.models.includes(body.model) ? body.model : 'chat-pro';
  const sessionId = await ensureSession(prefix);

  const payload = {
    model: { providerID: CONFIG.providerID, modelID },
    parts: [{ type: 'text', text: textOf(last.content) }],
  };
  if (sys) payload.system = sys;
  // mode: yolo = 内核全自动执行工具（无人值守必需，否则会卡在权限应答）
  // 默认 yolo；可由请求里的 TA_MODE 或环境变量覆盖
  const mode = body.mode || process.env.TA_MODE || CONFIG.mode;
  if (mode) payload.mode = mode;
  // 指定 agent（内核里预置的 agent 定义）
  const agent = body.agent || process.env.TA_AGENT || CONFIG.agent;
  if (agent) payload.agent = agent;

  let r = await kernelCall('POST', `/session/${sessionId}/message`, payload);
  if (r.status !== 200 || !r.json) throw new Error('内核调用失败(' + r.status + '): ' + r.text.slice(0, 300));

  let data = r.json.data || r.json;
  let parts = data.parts || [];
  let text = parts.filter(p => p.type === 'text').map(p => p.text).join('');
  // 新建会话时偶发空回复，补发一次
  if (!text && !parts.some(p => p.type === 'tool')) {
    const r2 = await kernelCall('POST', `/session/${sessionId}/message`, payload);
    if (r2.status === 200 && r2.json) {
      const d2 = r2.json.data || r2.json;
      parts = d2.parts || parts;
      text = parts.filter(p => p.type === 'text').map(p => p.text).join('');
      data = d2;
    }
  }
  const info = data.info || {};
  const reasoning = parts.filter(p => p.type === 'reasoning').map(p => p.text).join('');
  let toolParts = parts.filter(p => p.type === 'tool');

  // 内核 agent loop 的工具调用发生在**后续消息**里，
  // POST /message 只返回最后一条 → 需要拉会话消息历史补齐 tool part
  if (toolParts.length === 0 && CONFIG.collectTools) {
    try {
      const h = await kernelCall('GET', `/session/${sessionId}/message`);
      if (h.status === 200 && h.json) {
        const arr = Array.isArray(h.json) ? h.json : (h.json.data || []);
        const all = [];
        for (const m of arr) {
          for (const p of (m.parts || [])) {
            if (p.type === 'tool') all.push(p);
          }
        }
        if (all.length) toolParts = all;
      }
    } catch (_) { /* 拉不到就算了，不影响主流程 */ }
  }

  sessionMap.set(H(rest), sessionId);
  sessionMap.set(H([...rest, { role: 'assistant', content: text }]), sessionId);

  return { text, reasoning, toolParts, info, usage: info.tokens || {}, modelID };
}

function openaiResponse(result, model) {
  const u = result.usage || {};
  const msg = { role: 'assistant', content: result.text };
  // 内核 agent loop 执行了工具时，把工具调用信息一并带出（OpenAI 扩展字段）
  if (result.toolParts && result.toolParts.length) {
    msg.tool_calls = result.toolParts.map((p, i) => ({
      id: 'call_' + crypto.randomBytes(8).toString('hex'),
      type: 'function',
      function: {
        name: p.tool || 'unknown',
        arguments: JSON.stringify({
          input: (p.state && (p.state.input || p.state.args)) || {},
          status: p.state && p.state.status,
          title: p.state && p.state.title,
          output: (p.state && (p.state.output || p.state.result)) ? String(p.state.output || p.state.result).slice(0, 4000) : undefined,
        }),
      },
      _index: i,
    }));
    msg.tool_execution = result.toolParts.map(p => ({
      tool: p.tool,
      status: p.state && p.state.status,
      title: p.state && p.state.title,
    }));
  }
  if (result.reasoning) msg.reasoning_content = result.reasoning;
  return {
    id: 'chatcmpl-' + crypto.randomBytes(12).toString('hex'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: msg, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: u.input || 0,
      completion_tokens: u.output || 0,
      total_tokens: (u.input || 0) + (u.output || 0),
    },
  };
}

function sseStream(res, result, model) {
  const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish) => 'data: ' + JSON.stringify({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finish || null }],
  }) + '\n\n';
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
    ...(require('./ta-api').CORS_HEADERS),
  });
  res.write(chunk({ role: 'assistant', content: '' }));
  const text = result.text || '';
  for (let i = 0; i < text.length; i += 24) res.write(chunk({ content: text.slice(i, i + 24) }));
  res.write(chunk({}, 'stop'));
  res.write('data: [DONE]\n\n');
  res.end();
}

// ===================== HTTP 服务 =====================
const api = require('./ta-api');

function sendJSON(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...api.CORS_HEADERS, ...extraHeaders });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, api.CORS_HEADERS);
    return res.end();
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = (req.url || '').split('?')[0];

    // 鉴权（/health 不需要）
    if (url !== '/health' && url !== '/') {
      const auth = api.checkAuth(req, CONFIG.apiKey);
      if (!auth.ok) {
        const isAnthropic = url === '/v1/messages';
        return sendJSON(res, auth.status, isAnthropic ? api.anthropicError(auth.body.error.message) : auth.body);
      }
    }

    try {
      // ---------- 健康检查 / 服务信息 ----------
      if (req.method === 'GET' && (url === '/health' || url === '/')) {
        return sendJSON(res, 200, {
          ok: true,
          service: 'teleagent-local-shim',
          version: '1.0',
          key: !!getKey(),
          host: CONFIG.host,
          port: CONFIG.port,
          auth: CONFIG.apiKey ? 'on' : 'off',
          endpoints: ['/v1/models', '/v1/chat/completions', '/v1/messages', '/v1/responses', '/health'],
        });
      }

      // ---------- 模型列表 ----------
      if (req.method === 'GET' && url === '/v1/models') {
        return sendJSON(res, 200, {
          object: 'list',
          data: CONFIG.models.map(id => ({
            id, object: 'model', created: 0, owned_by: 'teleagent-local',
          })),
        });
      }

      // ---------- OpenAI Chat Completions ----------
      if (req.method === 'POST' && url === '/v1/chat/completions') {
        const body = JSON.parse(raw || '{}');
        const result = await chatCompletion(body);
        if (body.stream) return sseStream(res, result, body.model);
        return sendJSON(res, 200, openaiResponse(result, body.model));
      }

      // ---------- Anthropic Messages（Claude Code / Cline 原生支持） ----------
      if (req.method === 'POST' && url === '/v1/messages') {
        const body = JSON.parse(raw || '{}');
        const result = await chatCompletion(api.anthropicToOpenAI(body));
        if (body.stream) return api.anthropicSse(res, result, body.model);
        return sendJSON(res, 200, api.anthropicResponse(result, body.model));
      }

      // ---------- OpenAI Responses API ----------
      if (req.method === 'POST' && url === '/v1/responses') {
        const body = JSON.parse(raw || '{}');
        const result = await chatCompletion(api.responsesToOpenAI(body));
        return sendJSON(res, 200, api.responsesResponse(result, body.model));
      }

      // ---------- 旧版 Completions ----------
      if (req.method === 'POST' && url === '/v1/completions') {
        const body = JSON.parse(raw || '{}');
        const prompt = typeof body.prompt === 'string' ? body.prompt
          : (Array.isArray(body.prompt) ? body.prompt.map(p => p.text || '').join('\n') : '');
        const result = await chatCompletion({
          model: body.model,
          messages: [{ role: 'user', content: prompt }],
        });
        return sendJSON(res, 200, {
          id: 'cmpl-' + crypto.randomBytes(12).toString('hex'),
          object: 'text_completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model || 'chat-pro',
          choices: [{ index: 0, text: result.text, logprobs: null, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: (result.usage && result.usage.input) || 0,
            completion_tokens: (result.usage && result.usage.output) || 0,
            total_tokens: ((result.usage && result.usage.input) || 0) + ((result.usage && result.usage.output) || 0),
          },
        });
      }

      return sendJSON(res, 404, api.openaiError('not found: ' + url, 'invalid_request_error', 'not_found'));
    } catch (e) {
      const msg = String((e && e.message) || e);
      console.error('[shim] error:', msg);
      const isAnthropic = url === '/v1/messages';
      return sendJSON(res, 500, isAnthropic ? api.anthropicError(msg) : api.openaiError(msg, 'server_error'));
    }
  });
});

const HOSTS = {
  '127.0.0.1': '127.0.0.1',
  'localhost': '127.0.0.1',
  '0.0.0.0': '0.0.0.0',
};

server.listen(CONFIG.port, HOSTS[CONFIG.host] || CONFIG.host, () => {
  const shown = (HOSTS[CONFIG.host] || CONFIG.host);
  console.log('[shim] listening on http://%s:%d/v1', shown, CONFIG.port);
  if (shown === '0.0.0.0') {
    console.log('[shim] 已对外监听 —— 局域网内其他设备可用本机 IP 访问');
    console.log('[shim] 鉴权: %s', CONFIG.apiKey ? '已开启' : '未开启（建议设置 TA_API_KEY）');
  }
  console.log('[shim] kernel = %s  provider = %s', CONFIG.kernel, CONFIG.providerID);
  console.log('[shim] models = %s', CONFIG.models.join(', '));
  console.log('[shim] mode = %s', CONFIG.mode);
  const k = getKey();
  console.log('[shim] sessionKey = %s', k ? k.slice(0, 8) + '...' : '未取到（将在首个请求时重试）');
});
