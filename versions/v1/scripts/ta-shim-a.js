#!/usr/bin/env node
/**
 * ta-shim-a.js — 方案 A：直连云网关的 OpenAI 兼容 API（支持自定义 tools）。
 *
 *   你的 agent (pi/Cline/Cursor/Claude Code)
 *        │  OpenAI 协议 + 自定义 tools
 *        ▼
 *   本 shim (127.0.0.1:8790)
 *        │  补上 TeleAgent 网关鉴权头 + 两轮 HMAC 签名
 *        ▼
 *   https://agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions
 *
 * 与方案 B（ta-shim.js）的区别：
 *   - 方案 B：出站由 App 进程发出，封号风险低，但**不接受自定义 tools**
 *   - 方案 A：自己直连，**原生支持自定义 tools**（agent 自己控制工具循环），
 *              但出站是「第二客户端」特征，封号风险更高
 *
 * 用法:
 *   node ta-shim-a.js
 *   TA_PORT=8790 TA_API_KEY=xxx node ta-shim-a.js
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { getToken, getDeviceMeta } = require('./ta-token');
const { computeSignature } = require('./ta-gw-sign');
const { extractChannelKey } = require('./ta-gateway');
const api = require('./ta-api');

const CONFIG = {
  port: Number(process.env.TA_PORT || 8790),
  host: process.env.TA_HOST || '127.0.0.1',
  apiKey: process.env.TA_API_KEY || '',
  gateway: process.env.TA_GATEWAY || 'https://agent.teleai.com.cn/superCowork/sapi/api/v1',
  signPath: '/superCowork/sapi/api/v1/chat/completions',
  appVersion: process.env.TA_APP_VERSION || '3.0.1',
  models: ['chat-pro', 'chat-lite', 'chat-flash', 'chat-flagship', 'chat-nano'],
  // 直连网关需要完整的工具集描述；这里不做限制，原样透传
  dir: __dirname,
};

// ===================== 网关调用 =====================
let _token = null, _tokenTs = 0;
function currentToken() {
  if (_token && Date.now() - _tokenTs < 5 * 60 * 1000) return _token;
  _token = getToken().token;
  _tokenTs = Date.now();
  return _token;
}

function buildSignedHeaders(bodyBuf, token, opts = {}) {
  const dm = getDeviceMeta();
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const method = opts.method || 'POST';
  const signPath = opts.signPath || CONFIG.signPath;

  const signature = computeSignature(
    token, method, signPath, ts, nonce, bodyBuf,
    dm.installId, CONFIG.appVersion, 'v3'
  );

  return {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'User-Agent': 'super-agent/1.0',
    'Authorization': 'Bearer ' + extractChannelKey(),
    'X-Token': token,
    'X-Route-Target': 'ops-gateway',
    'X-Runtime-Env': 'ctyun_pc',
    'X-App-Version': CONFIG.appVersion,
    'X-SuperAgent-Timestamp': String(ts),
    'X-SuperAgent-Nonce': nonce,
    'X-SuperAgent-Device-Id': dm.deviceId || '',
    'X-SuperAgent-Install-Id': dm.installId || '',
    'X-SuperAgent-Sign-Version': 'v1',
    'X-SuperAgent-Signature': signature,
  };
}

/**
 * 调网关
 * @returns {Promise<{status, text, headers}>}
 */
async function callGateway(body, opts = {}) {
  const bodyBuf = Buffer.from(JSON.stringify(body), 'utf8');
  const token = currentToken();
  const headers = buildSignedHeaders(bodyBuf, token, opts);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs || 600000);
  try {
    const r = await fetch(CONFIG.gateway + '/chat/completions', {
      method: 'POST', headers, body: bodyBuf, signal: ac.signal,
    });
    const text = await r.text();
    return { status: r.status, text, headers: r.headers };
  } finally {
    clearTimeout(timer);
  }
}

/** 网关返回错误 → 统一错误体 */
function gatewayError(status, text) {
  let code = null, msg = text;
  try {
    const j = JSON.parse(text);
    code = j.code || j.error?.code || null;
    msg = j.message || j.error?.message || text;
  } catch (_) {}
  const map = {
    40101: 'missing super agent security headers',
    40104: 'invalid signature',
    40105: '疑似攻击（风控）— 已停止请求',
    40109: 'current user is banned',
    403: '内容审核拒绝或权限不足',
  };
  return { status, body: api.openaiError(String(msg) + (code ? ' (' + code + ')' : ''),
    'invalid_request_error', code) };
}

/** 网关 SSE → OpenAI SSE 透传（内容已是 OpenAI 格式） */
function pipeSse(res, gatewayText) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
    ...api.CORS_HEADERS,
  });
  res.end(gatewayText);
}

// ===================== HTTP 服务 =====================
function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...api.CORS_HEADERS });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, api.CORS_HEADERS);
    return res.end();
  }
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = (req.url || '').split('?')[0];

    if (url !== '/health' && url !== '/') {
      const auth = api.checkAuth(req, CONFIG.apiKey);
      if (!auth.ok) return sendJSON(res, auth.status, auth.body);
    }

    try {
      if (req.method === 'GET' && (url === '/health' || url === '/')) {
        return sendJSON(res, 200, {
          ok: true,
          service: 'teleagent-gateway-shim',
          mode: 'A-direct-gateway',
          supportsCustomTools: true,
          host: CONFIG.host, port: CONFIG.port,
          auth: CONFIG.apiKey ? 'on' : 'off',
          endpoints: ['/v1/models', '/v1/chat/completions', '/v1/messages', '/v1/responses', '/health'],
        });
      }

      if (req.method === 'GET' && url === '/v1/models') {
        return sendJSON(res, 200, {
          object: 'list',
          data: CONFIG.models.map(id => ({ id, object: 'model', created: 0, owned_by: 'teleai-gateway' })),
        });
      }

      if (req.method === 'POST' && url === '/v1/chat/completions') {
        const body = JSON.parse(raw || '{}');
        const r = await callGateway(body);
        if (r.status === 200) {
          if (body.stream) return pipeSse(res, r.text);
          res.writeHead(200, { 'Content-Type': 'application/json', ...api.CORS_HEADERS });
          return res.end(r.text);
        }
        const e = gatewayError(r.status, r.text);
        console.error('[shim-a] gateway %d: %s', r.status, e.body.error.message);
        return sendJSON(res, e.status, e.body);
      }

      if (req.method === 'POST' && url === '/v1/messages') {
        const body = JSON.parse(raw || '{}');
        const r = await callGateway(api.anthropicToOpenAI(body));
        if (r.status === 200) {
          if (body.stream) {
            // 网关返回 OpenAI SSE，转成 Anthropic 事件流
            const result = parseOpenAISSE(r.text);
            return api.anthropicSse(res, result, body.model);
          }
          const j = JSON.parse(r.text);
          return sendJSON(res, 200, api.anthropicResponse({
            text: j.choices?.[0]?.message?.content || '',
            usage: { input: j.usage?.prompt_tokens, output: j.usage?.completion_tokens },
          }, body.model));
        }
        const e = gatewayError(r.status, r.text);
        return sendJSON(res, e.status, api.anthropicError(e.body.error.message));
      }

      if (req.method === 'POST' && url === '/v1/responses') {
        const body = JSON.parse(raw || '{}');
        const r = await callGateway(api.responsesToOpenAI(body));
        if (r.status === 200) {
          const j = JSON.parse(r.text);
          return sendJSON(res, 200, api.responsesResponse({
            text: j.choices?.[0]?.message?.content || '',
            usage: { input: j.usage?.prompt_tokens, output: j.usage?.completion_tokens },
          }, body.model));
        }
        const e = gatewayError(r.status, r.text);
        return sendJSON(res, e.status, e.body);
      }

      return sendJSON(res, 404, api.openaiError('not found: ' + url, 'invalid_request_error', 'not_found'));
    } catch (e) {
      const msg = String((e && e.message) || e);
      console.error('[shim-a] error:', msg);
      return sendJSON(res, 500, api.openaiError(msg, 'server_error'));
    }
  });
});

/** 把网关的 OpenAI SSE 汇总成一段文本 */
function parseOpenAISSE(text) {
  let out = '';
  for (const l of text.split('\n\n')) {
    if (!l.startsWith('data: ')) continue;
    const d = l.slice(6).trim();
    if (!d || d === '[DONE]') continue;
    try {
      const o = JSON.parse(d);
      out += o.choices?.[0]?.delta?.content || '';
    } catch (_) {}
  }
  return { text: out };
}

const HOSTS = { '127.0.0.1': '127.0.0.1', 'localhost': '127.0.0.1', '0.0.0.0': '0.0.0.0' };
server.listen(CONFIG.port, HOSTS[CONFIG.host] || CONFIG.host, () => {
  const shown = HOSTS[CONFIG.host] || CONFIG.host;
  console.log('[shim-a] listening on http://%s:%d/v1', shown, CONFIG.port);
  console.log('[shim-a] gateway = %s/chat/completions', CONFIG.gateway);
  console.log('[shim-a] 自定义 tools 支持: 是');
  console.log('[shim-a] 鉴权: %s', CONFIG.apiKey ? '已开启' : '未开启');
});
