'use strict';
/**
 * proxy/server.js — 反代 HTTP 服务
 *
 * 关键设计：
 *   - 单个账号失效 → 立刻续期重试 → 仍失败则换下一个账号
 *   - 全部账号不可用 → 返回明确错误（503 + 提示重新登录），**服务本身不崩**
 *   - 每次请求用全新 nonce（服务端记 nonce，重用返回 40105）
 */

const http = require('http');
const { chatCompletion } = require('./gateway');
const { Refresher } = require('./refresher');
const api = require('./api');

function createServer(opts = {}) {
  const {
    store, pool, refresher, channelKey,
    apiKey = 'teleagent-local',
    appVersion = '3.1.0',
    log = () => {},
  } = opts;

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '').split('?')[0];
    const method = req.method || 'GET';

    // ---- CORS（方便浏览器端调试）----
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    try {
      if (method === 'GET' && (url === '/health' || url === '/')) {
        return sendJSON(res, 200, {
          ok: true,
          service: 'teleagent-proxy-v2',
          mode: 'direct-gateway',
          supportsCustomTools: true,
          accounts: pool.summary(),
          version: '2.0.0',
        });
      }

      if (method === 'GET' && url === '/v1/models') {
        return sendJSON(res, 200, {
          object: 'list',
          data: api.MODELS.map((m) => ({
            id: m, object: 'model', created: 0, owned_by: 'teleagent',
          })),
        });
      }

      // ---- 需要鉴权的推理接口 ----
      if (method === 'POST' && ['/v1/chat/completions', '/v1/messages', '/v1/responses'].includes(url)) {
        const auth = req.headers.authorization || '';
        const xApiKey = req.headers['x-api-key'] || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(xApiKey).trim();
        if (apiKey && token !== apiKey) {
          return sendJSON(res, 401, { error: { message: '无效的 API Key', type: 'authentication_error' } });
        }

        const body = await readBody(req);
        let parsed;
        try { parsed = JSON.parse(body); }
        catch (e) { return sendJSON(res, 400, { error: { message: '请求体不是合法 JSON' } }); }

        const result = await handleInference(url, parsed);
        return sendJSON(res, result.status, result.payload);
      }

      return sendJSON(res, 404, { error: { message: `未知路径 ${method} ${url}` } });
    } catch (e) {
      log(`[错误] ${e.message}`);
      log(e.stack || '');
      return sendJSON(res, 500, { error: { message: e.message } });
    }
  });

  /**
   * 处理一次推理：选账号 → 请求 → 失败续期重试 → 换号
   */
  async function handleInference(url, body) {
    const isAnthropic = url === '/v1/messages';
    const isResponses = url === '/v1/responses';

    const gwBody = isAnthropic ? api.anthropicToGateway(body)
      : isResponses ? api.openaiToGateway(body)
        : api.openaiToGateway(body);

    const maxAttempts = Math.max(1, Math.min(3, pool.usable().length || 1));
    let lastErr = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const rec = pool.pick();
      if (!rec) {
        const summary = pool.summary();
        return {
          status: 503,
          payload: {
            error: {
              message: summary.total === 0
                ? '没有可用账号。请先运行 `tav2 scan` 扫描本机账号，或 `tav2 import <file>` 导入账号包。'
                : `没有可用账号（${summary.needsRelogin} 个需要重新登录）。请在 TeleAgent 中重新登录后运行 \`tav2 scan\`。`,
              type: 'no_available_account',
              accounts: summary,
            },
          },
        };
      }

      // 账号 token 可能已过期 → 先尝试续期
      const fresh = refresher ? await refresher.ensureFresh(rec) : rec;

      const r = await chatCompletion({
        token: fresh.token,
        channelKey,
        deviceId: pool.deviceId,
        installId: pool.installId,
        appVersion,
        body: gwBody,
      });

      if (r.status === 200 && r.json) {
        pool.reportSuccess(fresh.id);
        const payload = isAnthropic ? api.gatewayToAnthropic(r.json, body.model)
          : isResponses ? api.gatewayToResponses(r.json, body.model)
            : api.gatewayToOpenai(r.json, body.model);
        return { status: 200, payload };
      }

      const err = api.extractError(r.text, r.status);
      lastErr = err;
      log(`[推理] 账号 ${fresh.accountName || fresh.id} 失败：${err.code} ${err.message}`);

      // 可续期的错误 → 立刻续期后重试同一账号
      if (refresher && Refresher.isRetryable(err.code) && attempt < maxAttempts - 1) {
        const rr = await refresher.refreshOne(fresh.id, '请求失败');
        if (rr.ok) {
          log(`[推理] 账号 ${fresh.accountName || fresh.id} 续期后重试`);
          attempt--;       // 用同一个账号再来一次
          continue;
        }
      }

      // 终止性错误 → 标记该账号，换下一个
      if (Refresher.isTerminal(err.code)) {
        pool.reportFailure(fresh.id, { ...err, fatal: true });
      } else {
        pool.reportFailure(fresh.id, err);
      }
    }

    return {
      status: lastErr && lastErr.code >= 400 && lastErr.code < 600 ? lastErr.code : 502,
      payload: {
        error: {
          message: `网关请求失败：${lastErr ? lastErr.code + ' ' + lastErr.message : '未知错误'}`,
          type: 'upstream_error',
        },
      },
    };
  }

  return server;
}

function sendJSON(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

module.exports = { createServer };
