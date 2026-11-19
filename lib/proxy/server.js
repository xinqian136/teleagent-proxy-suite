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
const fs = require('fs');
const { chatCompletion } = require('./gateway');
const { Refresher } = require('./refresher');
const api = require('./api');
const sse = require('./sse');
const media = require('./media');

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

        recordRequest(url, method, parsed);

        // ★ 流式：客户端要 SSE 就给 SSE（不能吞掉，否则客户端干等到超时）
        if (parsed.stream === true) {
          return await handleStream(url, parsed, res);
        }

        const result = await handleInference(url, parsed);
        if (result.raw !== undefined) {
          // 网关原始 JSON 直传
          res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(result.raw);
        }
        return sendJSON(res, result.status, result.payload);
      }

      return sendJSON(res, 404, { error: { message: `未知路径 ${method} ${url}` } });
    } catch (e) {
      log(`[错误] ${e.message}`);
      log(e.stack || '');
      if (!res.headersSent) {
        return sendJSON(res, 500, { error: { message: e.message } });
      }
      try { res.end(); } catch (_) {}
    }
  });

  /**
   * 流式推理：网关返回 SSE，边收边转给客户端
   *
   * OpenAI / Responses → 网关的 SSE 本身就是 OpenAI 格式，**原样透传**
   * Anthropic            → 转成 Anthropic 事件流
   */
  async function handleStream(url, body, res) {
    const isAnthropic = url === '/v1/messages';
    // ★ chat/completions 请求体透传（与方案A 一致），只有 Anthropic 需要转
    let gwBody = isAnthropic ? api.anthropicToGateway(body)
      : url === '/v1/responses' ? api.responsesToGateway(body)
        : body;
    // ★ 媒体预处理：远程图片 → base64
    const mediaRes = await media.processBody(gwBody, log);
    gwBody = mediaRes.body;
    gwBody.stream = true;

    const rec = pool.pick();
    if (!rec) {
      const summary = pool.summary();
      return sendJSON(res, 503, {
        error: {
          message: summary.total === 0
            ? '没有可用账号。请先运行 `tav2 scan` 扫描本机账号，或 `tav2 import <file>` 导入账号包。'
            : `没有可用账号（${summary.needsRelogin} 个需要重新登录）。`,
          type: 'no_available_account',
        },
      });
    }

    const fresh = refresher ? await refresher.ensureFresh(rec) : rec;

    let r;
    try {
      r = await chatCompletion({
        token: fresh.token,
        channelKey,
        deviceId: pool.deviceId,
        installId: pool.installId,
        appVersion,
        body: gwBody,
        stream: true,
        timeoutMs: 600000,     // 复杂任务要几分钟，给足
      });
    } catch (e) {
      return sendJSON(res, 502, { error: { message: '网关连接失败：' + e.message } });
    }

    if (r.status !== 200 || !r.stream) {
      // 网关返回错误 → 转成错误事件流
      const text = r.text || '';
      const e = api.extractError(text, r.status);
      res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: `${e.code} ${e.message}`, type: 'upstream_error' } }));
      r.cleanup && r.cleanup();
      return;
    }

    try {
      if (isAnthropic) {
        await sse.openaiToAnthropicStream(res, r.stream, { model: body.model });
      } else {
        await sse.pipeRaw(res, r.stream);
      }
    } finally {
      r.cleanup && r.cleanup();
      pool.reportSuccess(fresh.id);
    }
  }

  /**
   * 处理一次推理：选账号 → 请求 → 失败续期重试 → 换号
   */
  async function handleInference(url, body) {
    const isAnthropic = url === '/v1/messages';
    const isResponses = url === '/v1/responses';

    // ★ chat/completions 完全透传 —— 与 v1 方案A 行为一致。
    //   自己重建请求体最容易丢字段（content 块、tool_call_id、自定义参数…），
    //   而客户端（IDE Agent）对丢失极其敏感。
    const gwBody = isAnthropic ? api.anthropicToGateway(body)
      : isResponses ? api.responsesToGateway(body)
        : body;

    // ★ 媒体预处理：网关只吃 base64，远程 URL 的图要先抓下来转 base64
    const mediaRes = await media.processBody(gwBody, log);
    const finalBody = mediaRes.body;

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
        body: finalBody,
        timeoutMs: 600000,     // 复杂任务要几分钟，给足
      });

      if (r.status === 200 && r.json) {
        pool.reportSuccess(fresh.id);
        // ★ chat/completions 原样返回网关的 JSON —— 不重建。
        //   重建会丢 reasoning_content / usage 细节 / 自定义字段。
        if (!isAnthropic && !isResponses) {
          return { status: 200, raw: r.text };
        }
        const payload = isAnthropic ? api.gatewayToAnthropic(r.json, body.model)
          : api.gatewayToResponses(r.json, body.model);
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

  /**
   * 记录进来的请求（调试用）
   *
   * 只记摘要，不记完整 body —— body 里可能有文件内容和敏感信息。
   * 目的是看清「客户端到底发了什么格式」：哪个端点、有没有 stream、
   * 消息角色序列、content 是字符串还是块数组、有没有 tools。
   */
  function recordRequest(pathname, method, j) {
    if (!opts.recordFile) return;
    try {
      const parts = [];
      parts.push('model=' + (j.model || '-'));
      parts.push('stream=' + (j.stream === undefined ? '-' : j.stream));
      if (j.messages) {
        parts.push('messages=' + j.messages.length);
        const roles = j.messages.map((m) => {
          const kind = Array.isArray(m.content) ? '[' + m.content.length + '块:' +
            m.content.map((c) => c.type).join('+') + ']' : 'str';
          const tc = m.tool_calls ? '+tc' : '';
          const tcid = m.tool_call_id ? '+tcid' : '';
          return m.role + kind + tc + tcid;
        });
        parts.push('roles=[' + roles.join(',') + ']');
      }
      if (j.input) parts.push('input=' + (Array.isArray(j.input) ? j.input.length : 'str'));
      if (j.instructions) parts.push('instructions=' + String(j.instructions).length + '字');
      if (j.system) parts.push('system=' + (typeof j.system === 'string' ? j.system.length + '字' : '块'));
      if (j.tools) parts.push('tools=' + j.tools.length + '个');
      if (j.tool_choice) parts.push('tool_choice=' + JSON.stringify(j.tool_choice));
      if (j.max_tokens) parts.push('max_tokens=' + j.max_tokens);

      // 图片/文件块的细节 —— 定位「传图失败」的关键
      const media = [];
      const scanContent = (c) => {
        if (!Array.isArray(c)) return;
        for (const b of c) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'image_url' || b.type === 'input_image') {
            const u = typeof b.image_url === 'string' ? b.image_url : (b.image_url && b.image_url.url) || '';
            media.push('image_url:' + (u.startsWith('data:') ? 'data(' + Math.round(u.length / 1024) + 'KB)'
              : u.startsWith('http') ? 'HTTP!' : (u ? u.slice(0, 30) : '空')));
          } else if (b.type === 'image') {
            const s = b.source || {};
            media.push('image:' + (s.type || '?'));
          } else if (b.type === 'file' || b.type === 'input_file' || b.type === 'document') {
            media.push(b.type);
          }
        }
      };
      for (const m of (j.messages || [])) scanContent(m.content);
      for (const it of (j.input || [])) scanContent(it && it.content);
      if (media.length) parts.push('媒体[' + media.join(',') + ']');

      const line = JSON.stringify({
        t: Date.now(), path: pathname, method,
        summary: parts.join(' '),
      });
      fs.appendFileSync(opts.recordFile, line + '\n');
      // 上限 2MB，超了从头重写
      try {
        if (fs.statSync(opts.recordFile).size > 2 * 1024 * 1024) {
          const lines = fs.readFileSync(opts.recordFile, 'utf8').trim().split('\n');
          fs.writeFileSync(opts.recordFile, lines.slice(-500).join('\n') + '\n');
        }
      } catch (_) {}
    } catch (_) {}
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
