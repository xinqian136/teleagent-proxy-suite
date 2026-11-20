'use strict';
/**
 * web/server.js — Web 后台
 *
 * 一个进程、一个端口，三块路由：
 *   /                 管理界面（静态页）
 *   /api/admin/*      管理 API：扫描/导入/导出/账号增删改/设置/日志
 *   /v1/*             反代 API：OpenAI / Anthropic 兼容
 *
 * 反代由 ProxyManager 托管，可在界面上随时启停、改端口、改 API Key。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { scan, scanInto, teleAgentDataDir } = require('../account-manager/scanner');
const { exportAccounts } = require('../account-manager/exporter');
const { importInto } = require('../account-manager/importer');
const { evaluate, describe, describeAbsolute, STATUS } = require('../account-manager/model');
const { resolveChannelKey } = require('../proxy/gateway');
const { buildConfigs } = require('../proxy/client-config');

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function createWebServer(ctx) {
  const { settings, manager, getStore, log } = ctx;
  const logBuf = [];

  function pushLog(line) {
    logBuf.push({ t: Date.now(), line });
    if (logBuf.length > 500) logBuf.shift();
  }

  const logger = {
    info: (m) => { pushLog(m); log(m); },
    warn: (m) => { pushLog(m); log(m); },
    error: (m) => { pushLog(m); log(m); },
    raw: (m) => log(m),
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;
    const method = req.method || 'GET';

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    try {
      // ---- 管理界面 ----
      if (method === 'GET' && (p === '/' || p === '/index.html')) {
        return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
      }
      if (method === 'GET' && (p === '/app.js' || p === '/style.css')) {
        return serveFile(res, path.join(PUBLIC_DIR, p.slice(1)));
      }
      if (method === 'GET' && p === '/favicon.ico') {
        res.writeHead(204); res.end(); return;
      }

      // ---- 管理 API ----
      // ★ 必须 await：否则 handler 里的异步异常会变成 unhandledRejection，
      //   Node 15+ 默认会终止进程（Web 后台会"莫名消失"）。
      if (p.startsWith('/api/admin/')) {
        return await handleAdmin(req, res, p.replace('/api/admin/', ''), url);
      }

      // ---- 反代 API（转发给内部反代服务）----
      if (p.startsWith('/v1/')) {
        if (!manager.isRunning()) {
          return sendJSON(res, 503, {
            error: { message: '反代服务未运行。请在「反代」页点击启动。', type: 'proxy_stopped' },
          });
        }
        return await proxyForward(req, res, p, url, method);
      }

      return sendJSON(res, 404, { error: { message: 'Not found: ' + p } });
    } catch (e) {
      logger.error('处理异常: ' + e.message);
      try { sendJSON(res, 500, { error: { message: e.message } }); } catch (_) {}
    }
  });

  // ---------------------------------------------------------------- 管理 API

  async function handleAdmin(req, res, action, url) {
    const store = getStore();

    // 概览
    if (action === 'overview' && req.method === 'GET') {
      const list = store.list();
      const summary = {
        total: list.length,
        usable: list.filter((r) => evaluate(r).usable).length,
        needsRelogin: list.filter((r) => r.status === STATUS.NEEDS_RELOGIN).length,
        disabled: list.filter((r) => r.status === STATUS.DISABLED).length,
      };
      return sendJSON(res, 200, {
        accounts: summary,
        proxy: manager.status(),
        settings: publicSettings(),
        dataDir: path.join(ctx.root, 'data'),
        storage: store.stats(),
        node: process.version,
        platform: `${os.platform()} ${os.arch()}`,
        uptime: process.uptime(),
      });
    }

    // 账号列表
    if (action === 'accounts' && req.method === 'GET') {
      const list = store.list().map((r) => ({
        id: r.id,
        accountName: r.accountName,
        tenant: r.tenant,
        accountId: r.accountId,
        status: r.status,
        expiresAt: r.expiresAt,
        absoluteExpiresAt: r.absoluteExpiresAt,
        expiresIn: describe(r),
        absoluteExpiresIn: describeAbsolute(r),
        source: r.source,
        note: r.note || '',
        lastError: r.lastError || null,
        lastUsedAt: r.lastUsedAt || null,
        createdAt: r.createdAt,
        tokenPreview: r.token ? r.token.slice(0, 12) + '…' : '',
      }));
      return sendJSON(res, 200, { accounts: list });
    }

    // 账号修改（备注 / 状态 / 手动换 token）
    if (action === 'account' && (req.method === 'PUT' || req.method === 'POST')) {
      const body = await readJsonBody(req);
      const rec = store.get(body.id);
      if (!rec) return sendJSON(res, 404, { error: { message: '账号不存在' } });
      const patch = {};
      if (body.note !== undefined) patch.note = String(body.note);
      if (body.status !== undefined) {
        if (![STATUS.ACTIVE, STATUS.DISABLED, STATUS.NEEDS_RELOGIN].includes(body.status)) {
          return sendJSON(res, 400, { error: { message: '状态值不合法' } });
        }
        patch.status = body.status;
      }
      if (body.token) {
        if (!String(body.token).includes(':')) {
          return sendJSON(res, 400, { error: { message: 'token 格式应为 tenant:eyJ...' } });
        }
        patch.token = String(body.token).trim();
        patch.status = STATUS.ACTIVE;
      }
      patch.updatedAt = Date.now();
      const updated = store.update ? store.update(rec.id, patch) : store.put({ ...rec, ...patch });
      logger.info(`[账号] 已更新 ${rec.accountName || rec.id}`);
      return sendJSON(res, 200, { ok: true, account: { id: updated.id, note: updated.note, status: updated.status } });
    }

    // 删除账号
    if (action === 'account' && req.method === 'DELETE') {
      const body = await readJsonBody(req);
      const rec = store.get(body.id);
      if (!rec) return sendJSON(res, 404, { error: { message: '账号不存在' } });
      store.remove(body.id);
      logger.info(`[账号] 已删除 ${rec.accountName || rec.id}`);
      return sendJSON(res, 200, { ok: true });
    }

    // 扫描本机
    if (action === 'scan' && req.method === 'POST') {
      const r = scanInto(store);
      for (const e of r.errors) logger.warn(`[扫描] ${e.message}`);
      return sendJSON(res, 200, {
        ok: true,
        added: r.added.length,
        updated: r.updated.length,
        errors: r.errors,
        dataDir: teleAgentDataDir(),
      });
    }

    // 导入
    if (action === 'import' && req.method === 'POST') {
      const body = await readJsonBody(req);
      // 两种来源：上传的 bundle 文本，或服务器上的路径
      if (body.content) {
        const tmp = path.join(ctx.root, 'data', `.import-${Date.now()}.bundle`);
        fs.mkdirSync(path.join(ctx.root, 'data'), { recursive: true });
        fs.writeFileSync(tmp, body.content, 'utf8');
        try {
          const r = importInto(store, tmp, { password: body.password || null });
          return sendJSON(res, 200, importResult(r));
        } finally {
          try { fs.unlinkSync(tmp); } catch (_) {}
        }
      }
      if (body.path) {
        const r = importInto(store, path.resolve(body.path), { password: body.password || null });
        return sendJSON(res, 200, importResult(r));
      }
      return sendJSON(res, 400, { error: { message: '需要 content 或 path' } });
    }

    function importResult(r) {
      if (r.channelKey) {
        const ckPath = path.join(ctx.root, 'config', 'channel-key.txt');
        try {
          fs.mkdirSync(path.dirname(ckPath), { recursive: true });
          fs.writeFileSync(ckPath, r.channelKey, 'utf8');
          logger.info('[导入] 渠道密钥已自动配置');
        } catch (_) {}
      }
      for (const e of r.errors || []) logger.warn(`[导入] ${e.message}`);
      return {
        ok: true,
        added: r.added.length,
        updated: r.updated.length,
        errors: r.errors || [],
        channelKeyApplied: !!r.channelKey,
      };
    }

    // 导出
    if (action === 'export' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const format = body.format || 'bundle';
      const records = store.list();
      if (!records.length) return sendJSON(res, 400, { error: { message: '没有可导出的账号' } });

      const ck = resolveChannelKey({
        configDir: path.join(ctx.root, 'config'),
        dataDir: path.join(ctx.root, 'data'),
      });
      const r = exportAccounts(records, {
        format,
        password: body.password || null,
        channelKey: ck.key,
      });

      if (format === 'bundle') {
        const outName = body.filename || `account-${new Date().toISOString().slice(0, 10)}.bundle`;
        const outPath = path.join(ctx.root, 'data', outName);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, r.content, 'utf8');
        logger.info(`[导出] ${r.count} 个账号 → ${outName}`);
        return sendJSON(res, 200, {
          ok: true, format, count: r.count, encrypted: r.encrypted,
          filename: outName, path: outPath, content: r.content,
        });
      }
      // xlsx / csv → 直接给二进制下载
      if (format === 'xlsx') {
        const outName = body.filename || `accounts-${new Date().toISOString().slice(0, 10)}.xlsx`;
        const outPath = path.join(ctx.root, 'data', outName);
        const xlsx = require('../xlsx');
        const { headers, rows } = r;
        xlsx.write(outPath, headers, rows, '账号');
        logger.info(`[导出] ${r.count} 个账号 → ${outName}`);
        return sendJSON(res, 200, {
          ok: true, format, count: r.count, filename: outName, path: outPath,
          downloadUrl: '/api/admin/download?file=' + encodeURIComponent(outName),
        });
      }
      return sendJSON(res, 200, { ok: true, format: 'csv', count: r.count, content: r.content });
    }

    // 下载导出文件
    if (action === 'download' && req.method === 'GET') {
      const file = url.searchParams.get('file') || '';
      const safe = path.basename(file);
      const p = path.join(ctx.root, 'data', safe);
      if (!fs.existsSync(p)) return sendJSON(res, 404, { error: { message: '文件不存在' } });
      const ext = path.extname(p).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(safe)}"`,
      });
      return res.end(fs.readFileSync(p));
    }

    // 设置：读
    if (action === 'settings' && req.method === 'GET') {
      return sendJSON(res, 200, { settings: publicSettings() });
    }

    // 设置：写（部分更新）
    if (action === 'settings' && (req.method === 'PUT' || req.method === 'POST')) {
      const body = await readJsonBody(req);
      const patch = body.settings || body;

      // 校验
      if (patch['proxy.port'] !== undefined && !require('./settings').Settings.validPort(patch['proxy.port'])) {
        return sendJSON(res, 400, { error: { message: '端口不合法（1-65535）' } });
      }
      if (patch['proxy.apiKey'] !== undefined) {
        const k = String(patch['proxy.apiKey']).trim();
        if (!k) return sendJSON(res, 400, { error: { message: 'API Key 不能为空' } });
        if (k.length < 8) return sendJSON(res, 400, { error: { message: 'API Key 至少 8 位' } });
        patch['proxy.apiKey'] = k;
      }
      if (patch['storage'] !== undefined && !['json', 'sqlite'].includes(patch['storage'])) {
        return sendJSON(res, 400, { error: { message: '存储类型只能是 json 或 sqlite' } });
      }
      if (patch['proxy.paused'] !== undefined) {
        patch['proxy.paused'] = !!patch['proxy.paused'];
      }

      const before = {
        port: settings.get('proxy.port'),
        apiKey: settings.get('proxy.apiKey'),
        visionFallback: settings.get('proxy.visionFallback') !== false,
      };
      settings.patch(patch);
      logger.info('[设置] 已更新: ' + Object.keys(patch).join(', '));

      // 端口 / API Key / 视觉降级开关变了 → 反代热重启
      let restarted = false;
      let restartError = null;
      const after = {
        port: settings.get('proxy.port'),
        apiKey: settings.get('proxy.apiKey'),
        visionFallback: settings.get('proxy.visionFallback') !== false,
      };
      if (before.port !== after.port || before.apiKey !== after.apiKey
          || before.visionFallback !== after.visionFallback) {
        if (manager.isRunning()) {
          const r = await manager.restart();
          restarted = true;
          if (!r.ok) restartError = r.error;
        }
      }
      return sendJSON(res, 200, {
        ok: true,
        settings: publicSettings(),
        proxyRestarted: restarted,
        proxyError: restartError,
      });
    }

    // 设置：恢复默认
    if (action === 'settings/reset' && req.method === 'POST') {
      settings.reset();
      logger.info('[设置] 已恢复默认');
      return sendJSON(res, 200, { ok: true, settings: publicSettings() });
    }

    // 反代：启停
    if (action === 'proxy/start' && req.method === 'POST') {
      const r = await manager.start();
      if (!r.ok) return sendJSON(res, 400, { error: { message: r.error } });
      // 手动启动 = 解除暂停
      if (settings.get('proxy.paused')) settings.set('proxy.paused', false);
      return sendJSON(res, 200, { ok: true, proxy: manager.status() });
    }
    if (action === 'proxy/stop' && req.method === 'POST') {
      await manager.stop();
      return sendJSON(res, 200, { ok: true, proxy: manager.status() });
    }
    /**
     * 暂停 —— 与「停止」的区别是会持久化：
     * 重启后台后反代不会自动起来，需要手动点「恢复」。
     */
    if (action === 'proxy/pause' && req.method === 'POST') {
      await manager.stop();
      settings.set('proxy.paused', true);
      logger.info('[反代] 已暂停（重启后台后不会自动启动）');
      return sendJSON(res, 200, { ok: true, proxy: manager.status(), paused: true });
    }
    if (action === 'proxy/resume' && req.method === 'POST') {
      settings.set('proxy.paused', false);
      const r = await manager.start();
      if (!r.ok) return sendJSON(res, 400, { error: { message: r.error } });
      logger.info('[反代] 已恢复');
      return sendJSON(res, 200, { ok: true, proxy: manager.status(), paused: false });
    }
    if (action === 'proxy/restart' && req.method === 'POST') {
      const r = await manager.restart();
      if (!r.ok) return sendJSON(res, 400, { error: { message: r.error } });
      return sendJSON(res, 200, { ok: true, proxy: manager.status() });
    }
    if (action === 'proxy' && req.method === 'GET') {
      return sendJSON(res, 200, { proxy: manager.status(), paused: !!settings.get('proxy.paused') });
    }

    // 反代：对话测试
    if (action === 'test' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!manager.isRunning()) {
        return sendJSON(res, 400, { error: { message: '反代服务未运行' } });
      }
      const { chatCompletion } = require('../proxy/gateway');
      const { pool } = manager.instance;
      const rec = pool.pick();
      if (!rec) return sendJSON(res, 400, { error: { message: '没有可用账号' } });
      const c = manager.cfg();
      const r = await chatCompletion({
        token: rec.token,
        channelKey: manager.channelKey,
        deviceId: pool.deviceId,
        installId: pool.installId,
        appVersion: c.appVersion,
        body: {
          model: body.model || 'chat-flash',
          messages: [{ role: 'user', content: body.message || '你好' }],
          stream: false,
        },
      });
      if (r.status === 200 && r.json) {
        return sendJSON(res, 200, {
          ok: true,
          content: r.json.choices?.[0]?.message?.content || '',
          usage: r.json.usage || null,
          account: rec.accountName || rec.id,
        });
      }
      let e = { code: r.status, message: r.text.slice(0, 200) };
      try { const j = JSON.parse(r.text); e = { code: j.code, message: j.message }; } catch (_) {}
      return sendJSON(res, 502, { error: { message: `${e.code} ${e.message}` } });
    }

    // 客户端配置
    if (action === 'client-config' && req.method === 'GET') {
      const c = manager.cfg();
      const baseUrl = `http://${c.host}:${c.port}/v1`;
      return sendJSON(res, 200, {
        baseUrl, apiKey: c.apiKey,
        configs: buildConfigs({ baseUrl, apiKey: c.apiKey, model: 'chat-flagship' }),
      });
    }

    // 日志
    if (action === 'logs' && req.method === 'GET') {
      const n = parseInt(url.searchParams.get('n') || '200', 10);
      return sendJSON(res, 200, { logs: logBuf.slice(-n) });
    }

    // 进来的请求记录（调试用：看客户端到底发了什么格式）
    if (action === 'requests' && req.method === 'GET') {
      const n = parseInt(url.searchParams.get('n') || '100', 10);
      const p = path.join(ctx.root, 'data', 'requests.log');
      let lines = [];
      try {
        lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).slice(-n);
      } catch (_) {}
      return sendJSON(res, 200, {
        requests: lines.map((l) => { try { return JSON.parse(l); } catch (_) { return { raw: l }; } }),
      });
    }
    if (action === 'requests' && req.method === 'DELETE') {
      try { fs.unlinkSync(path.join(ctx.root, 'data', 'requests.log')); } catch (_) {}
      return sendJSON(res, 200, { ok: true });
    }

    // 网关响应记录（出问题时直接看网关说了什么）
    if (action === 'responses' && req.method === 'GET') {
      const n = parseInt(url.searchParams.get('n') || '100', 10);
      const p = path.join(ctx.root, 'data', 'requests.responses.log');
      let lines = [];
      try {
        lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).slice(-n);
      } catch (_) {}
      return sendJSON(res, 200, {
        responses: lines.map((l) => { try { return JSON.parse(l); } catch (_) { return { raw: l }; } }),
      });
    }
    if (action === 'responses' && req.method === 'DELETE') {
      try { fs.unlinkSync(path.join(ctx.root, 'data', 'requests.responses.log')); } catch (_) {}
      return sendJSON(res, 200, { ok: true });
    }

    // 立即续期
    if (action === 'refresh' && req.method === 'POST') {
      if (!manager.isRunning()) return sendJSON(res, 400, { error: { message: '反代未运行，无法续期' } });
      const { refresher } = manager.instance;
      const store2 = getStore();
      const now = Math.floor(Date.now() / 1000);
      const ahead = (settings.get('refresher.aheadHours') || 24) * 3600;
      const targets = store2.list().filter((r) => r.expiresAt && r.expiresAt - now < ahead);
      const results = [];
      for (const r of targets) {
        const res2 = await refresher.refreshOne(r.id, '手动');
        results.push({ id: r.id, name: r.accountName, ok: res2.ok, reason: res2.reason });
      }
      return sendJSON(res, 200, { ok: true, refreshed: results });
    }

    return sendJSON(res, 404, { error: { message: 'Unknown admin action: ' + action } });
  }

  /** 反代请求转发到内部服务 */
  async function proxyForward(req, res, p, url, method) {
    const inst = manager.instance;
    if (!inst.server) return sendJSON(res, 503, { error: { message: '反代未运行' } });
    // 直接把请求交给反代 server 的 handler
    const body = method === 'POST' ? await readBodyBuffer(req) : null;
    const fakeReq = Object.create(req);
    fakeReq.url = p + (url.search || '');
    fakeReq.method = method;
    fakeReq.headers = { ...req.headers, 'content-length': body ? String(body.length) : '0' };
    let data = null;
    if (body) {
      data = body;
      fakeReq.on = (ev, cb) => {
        if (ev === 'data') setImmediate(() => cb(body));
        if (ev === 'end') setImmediate(() => cb());
        if (ev === 'error') setImmediate(() => cb(new Error('body read error')));
        return fakeReq;
      };
    } else {
      fakeReq.on = (ev, cb) => {
        if (ev === 'end') setImmediate(() => cb());
        if (ev === 'error') setImmediate(() => cb(new Error('body read error')));
        return fakeReq;
      };
    }
    inst.server.emit('request', fakeReq, res);
  }

  /**
   * 记录进来的请求（调试用）
   * 只记摘要，不落完整 body —— 里面可能有敏感内容。
   */
  function recordRequest(pathname, method, body, search) {
    try {
      let summary = '';
      if (body && body.length) {
        let j = null;
        try { j = JSON.parse(body.toString('utf8')); } catch (_) {}
        if (j) {
          const parts = [];
          parts.push('model=' + (j.model || '-'));
          parts.push('stream=' + (j.stream === undefined ? '-' : j.stream));
          if (j.messages) {
            parts.push('messages=' + j.messages.length);
            const roles = j.messages.map((m) => m.role + (Array.isArray(m.content) ? `[${m.content.length}块]` : ''));
            parts.push('roles=[' + roles.join(',') + ']');
          }
          if (j.input) {
            parts.push('input=' + (Array.isArray(j.input) ? j.input.length : 'str'));
          }
          if (j.instructions) parts.push('instructions=' + j.instructions.length + '字');
          if (j.tools) parts.push('tools=' + j.tools.length + '个');
          if (j.tool_choice) parts.push('tool_choice=' + JSON.stringify(j.tool_choice));
          if (j.max_tokens) parts.push('max_tokens=' + j.max_tokens);
          if (j.system) parts.push('system=' + (typeof j.system === 'string' ? j.system.length + '字' : '块'));
          summary = parts.join(' ');
        } else {
          summary = 'non-json body ' + body.length + ' bytes';
        }
      }
      const line = JSON.stringify({
        t: Date.now(),
        path: pathname,
        method,
        query: search || '',
        summary,
      });
      fs.appendFileSync(path.join(ctx.root, 'data', 'requests.log'), line + '\n');
    } catch (_) {}
  }

  function publicSettings() {
    return {
      web: settings.get('web'),
      proxy: {
        port: settings.get('proxy.port'),
        host: settings.get('proxy.host'),
        apiKey: settings.get('proxy.apiKey'),
        autoStart: settings.get('proxy.autoStart'),
        paused: !!settings.get('proxy.paused'),
        visionFallback: settings.get('proxy.visionFallback') !== false,
      },
      storage: settings.get('storage'),
      refresher: settings.get('refresher'),
      appVersion: settings.get('appVersion'),
    };
  }

  return { server, logger, publicSettings };
}

// ---------------------------------------------------------------- 工具

function sendJSON(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function serveFile(res, p) {
  if (!fs.existsSync(p)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
  const ext = path.extname(p).toLowerCase();
  const data = fs.readFileSync(p);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
  });
  res.end(data);
}

function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBodyBuffer(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch (e) { throw new Error('请求体不是合法 JSON'); }
}

module.exports = { createWebServer };
