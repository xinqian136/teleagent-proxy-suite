#!/usr/bin/env node
/**
 * ta-gateway.js — 方案 A：直连 TeleAgent 云网关（OpenAI 兼容）。
 *
 * 3.0.1 鉴权机制（逆向自内核运行时环境 + /provider 配置）：
 *   Authorization: Bearer <通道密钥>
 *   X-Token: <tenant>:<JWT>            ← useSuperAgentAuth 注入用户登录态
 *   X-Route-Target: ops-gateway
 *   X-Runtime-Env: ctyun_pc
 *   X-App-Version: <version>
 *   User-Agent: super-agent/1.0
 *
 * 通道密钥不写死在代码里 —— 运行时从本机 TeleAgent 的 app.asar 里提取
 * （所有用户共用同一个 App 二进制，所以这个值与账号无关）。
 * 提取失败时可显式指定：环境变量 TA_CHANNEL_KEY。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { getToken, getDeviceMeta } = require('./ta-token');
const { computeSignature } = require('./ta-gw-sign');

const GATEWAY_BASE = 'https://agent.teleai.com.cn/superCowork/sapi/api/v1';

const ASAR_PATH = 'C:/Program Files/TeleAgent/resources/app.asar';
const CHANNEL_KEY_RE = /sk-[A-Za-z0-9]{20,32}/g;

let _channelKey = null;

/**
 * 从 TeleAgent 的 app.asar 里提取通道密钥。
 * app.asar 是 Electron 的 asar 打包格式：16 字节头 + JSON 文件表 + 文件内容。
 * 密钥在 NewApi provider 的默认配置里，直接全文正则扫最快。
 */
function extractChannelKey() {
  if (_channelKey) return _channelKey;

  // 1) 显式指定优先
  if (process.env.TA_CHANNEL_KEY) {
    _channelKey = process.env.TA_CHANNEL_KEY.trim();
    return _channelKey;
  }

  // 2) 从本机 app.asar 提取
  const candidates = [
    ASAR_PATH,
    path.join(process.env.ProgramFiles || 'C:/Program Files', 'TeleAgent', 'resources', 'app.asar'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'TeleAgent', 'resources', 'app.asar'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const fd = fs.openSync(p, 'r');
      try {
        // app.asar 约 165MB，latin1 逐块扫描，避免一次性转整串占内存
        const CHUNK = 1 << 22; // 4MB
        const buf = Buffer.alloc(CHUNK);
        let pos = 0;
        let tail = '';
        let found = null;
        while (found === null) {
          const n = fs.readSync(fd, buf, 0, CHUNK, pos);
          if (n <= 0) break;
          const s = tail + buf.toString('latin1', 0, n);
          const m = s.match(CHANNEL_KEY_RE);
          if (m) { found = m[0]; break; }
          tail = s.slice(-64);
          pos += n;
        }
        if (found) {
          _channelKey = found;
          return _channelKey;
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch (_) {}
  }

  throw new Error(
    '无法从 TeleAgent 提取通道密钥。请确认已安装并启动过 TeleAgent 桌面端，\n' +
    '或设置环境变量 TA_CHANNEL_KEY=<sk-...>'
  );
}

function buildHeaders(token, extra = {}, opts = {}) {
  const dm = getDeviceMeta();
  const ts = Math.floor(Date.now() / 1000);
  const nonce = opts.nonce || crypto.randomUUID();
  const appVersion = process.env.TA_APP_VERSION || '3.0.1';

  const h = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'User-Agent': 'super-agent/1.0',
    'Authorization': 'Bearer ' + extractChannelKey(),
    'X-Token': token,
    'X-Route-Target': 'ops-gateway',
    'X-Runtime-Env': 'ctyun_pc',
    'X-App-Version': appVersion,
    'X-SuperAgent-Timestamp': String(ts),
    'X-SuperAgent-Nonce': nonce,
    'X-SuperAgent-Device-Id': dm.deviceId || '',
    'X-SuperAgent-Install-Id': dm.installId || '',
    'X-SuperAgent-Sign-Version': 'v1',
    ...extra,
  };

  // 签名（若提供了 body 与 scheme 变体）
  if (opts.body !== undefined && opts.signVariant) {
    h['X-SuperAgent-Signature'] = computeSignature(
      token, opts.method || 'POST', opts.signPath || '/superCowork/sapi/api/v1/chat/completions',
      ts, nonce, opts.body, dm.installId, appVersion, opts.signVariant
    );
  }
  return h;
}

/**
 * 直连网关发一次 chat completion
 * @param {object} body OpenAI Chat Completions 请求体
 * @param {object} opts { token, headers, timeoutMs }
 */
async function chatCompletion(body, opts = {}) {
  const token = opts.token || getToken().token;
  const payload = JSON.stringify(body);
  const headers = buildHeaders(token, opts.headers, {
    body: payload, nonce: opts.nonce, signVariant: opts.signVariant,
    method: opts.method, signPath: opts.signPath,
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs || 300000);
  try {
    const r = await fetch(GATEWAY_BASE + '/chat/completions', {
      method: 'POST', headers, body: payload, signal: ac.signal,
    });
    const text = await r.text();
    return { status: r.status, text, headers: r.headers, sentHeaders: headers };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { GATEWAY_BASE, extractChannelKey, buildHeaders, chatCompletion };

if (require.main === module) {
  (async () => {
    const { token } = getToken();
    console.log('[+] token:', token.slice(0, 24) + '...');
    console.log('[+] channel key:', extractChannelKey().slice(0, 8) + '...');
    console.log('[+] POST', GATEWAY_BASE + '/chat/completions');
    const r = await chatCompletion({
      model: 'chat-flash',
      messages: [{ role: 'user', content: '说OK' }],
      stream: false,
    });
    console.log('[+] status:', r.status);
    console.log('[+] body:', r.text.slice(0, 1200));
  })().catch(e => { console.error('ERR', e.message); process.exit(1); });
}