'use strict';
/**
 * proxy/gateway.js — 直连 TeleAgent 云网关
 *
 * 两条路径：
 *   1. channel key 从本机 app.asar 提取（装了 TeleAgent 的机器）
 *   2. channel key 从 config/channel-key.txt 读（没装 TeleAgent 的机器 —— 打包带走时带上）
 *
 * 渠道密钥所有用户共用（硬编码在 app.asar 里），所以第 2 条路径完全可行。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildHeaders } = require('./signer');

const GATEWAY_BASE = 'https://agent.teleai.com.cn/superCowork/sapi';
const API_BASE = GATEWAY_BASE + '/api/v1';
const SIGN_PATH = '/superCowork/sapi/api/v1/chat/completions';

const CHANNEL_KEY_RE = /sk-[A-Za-z0-9]{20,32}/g;

/** 找本机 app.asar */
function findAppAsar() {
  const cands = [
    process.env.TA_ASAR,
    'C:/Program Files/TeleAgent/resources/app.asar',
    path.join(process.env.ProgramFiles || 'C:/Program Files', 'TeleAgent', 'resources', 'app.asar'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'TeleAgent', 'resources', 'app.asar'),
  ].filter(Boolean);
  for (const p of cands) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

/**
 * 从 app.asar 提取渠道密钥（4MB 分块扫，避免 981MB 一次性进内存）
 */
function extractChannelKeyFromAsar(asarPath) {
  const p = asarPath || findAppAsar();
  if (!p) return null;
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const CHUNK = 1 << 22;
    const buf = Buffer.alloc(CHUNK);
    let pos = 0;
    let tail = '';
    while (true) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      const s = tail + buf.toString('latin1', 0, n);
      const m = s.match(CHANNEL_KEY_RE);
      if (m) return m[0];
      tail = s.slice(-64);
      pos += n;
    }
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
  return null;
}

/**
 * 解析渠道密钥来源
 * @param {object} opts { configDir, dataDir }
 * @returns {{key:string|null, source:string}}
 */
function resolveChannelKey(opts = {}) {
  if (process.env.TA_CHANNEL_KEY) {
    return { key: process.env.TA_CHANNEL_KEY.trim(), source: 'env:TA_CHANNEL_KEY' };
  }
  // 打包带过来的
  const files = [
    path.join(opts.configDir || '', 'channel-key.txt'),
    path.join(opts.dataDir || '', 'channel-key.txt'),
  ].filter(Boolean);
  for (const f of files) {
    try {
      const v = fs.readFileSync(f, 'utf8').trim();
      if (/^sk-[A-Za-z0-9]{20,32}$/.test(v)) return { key: v, source: f };
    } catch (_) {}
  }
  // 本机 app.asar
  const k = extractChannelKeyFromAsar();
  if (k) return { key: k, source: findAppAsar() };
  return { key: null, source: null };
}

/**
 * 发一次 chat completion
 * @param {object} o
 * @param {string} o.token
 * @param {string} o.channelKey
 * @param {string} o.deviceId
 * @param {string} o.installId
 * @param {object} o.body   OpenAI Chat Completions 请求体
 * @param {string} [o.appVersion]
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{status:number, text:string, json:object|null}>}
 */
async function chatCompletion(o) {
  const payload = JSON.stringify(o.body);
  const headers = buildHeaders({
    token: o.token,
    channelKey: o.channelKey,
    deviceId: o.deviceId,
    installId: o.installId,
    appVersion: o.appVersion || '3.1.0',
    method: 'POST',
    path: SIGN_PATH,
    body: payload,
  });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs || 300000);
  try {
    const r = await fetch(API_BASE + '/chat/completions', {
      method: 'POST',
      headers,
      body: payload,
      signal: ac.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: r.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 续期 token
 * @param {object} o { token, deviceId, appVersion, timeoutMs }
 * @returns {Promise<{ok:boolean, token?:string, code?:number, message?:string}>}
 */
async function refreshToken(o) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Token': o.token,
    'X-Timestamp': String(Math.floor(Date.now() / 1000)),
    'X-Nonce': require('crypto').randomUUID(),
    'X-App-Version': o.appVersion || '3.1.0',
    'X-OS-Type': 'Windows',
    'X-SuperAgent-Device-Id': o.deviceId || '',
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs || 30000);
  try {
    const r = await fetch(GATEWAY_BASE + '/cowork/auth/token-refresh', {
      method: 'POST', headers, body: '', signal: ac.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    if (r.status === 200) {
      const at = json?.data?.accessToken || json?.accessToken;
      if (at) return { ok: true, token: at };
      return { ok: false, code: json?.code, message: '响应里没有 accessToken' };
    }
    return { ok: false, code: json?.code, message: json?.message || text.slice(0, 120), status: r.status };
  } catch (e) {
    return { ok: false, message: e.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  GATEWAY_BASE, API_BASE, SIGN_PATH,
  resolveChannelKey, extractChannelKeyFromAsar, findAppAsar,
  chatCompletion, refreshToken,
};
