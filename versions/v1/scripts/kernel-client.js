#!/usr/bin/env node
/**
 * kernel-client.js — 方案 B 的内核调用库（3.0.1 已验证兼容）
 * 签名协议：local-v1 + X-SA-Signature，payload = "local-v1\nMETHOD\nPATH\nTS\nNONCE"
 */
const crypto = require('crypto');
const http = require('http');

const KERNEL = process.env.TA_KERNEL_URL || 'http://127.0.0.1:4397';
let sessionKey = process.env.TA_SESSION_KEY || null;

function setSessionKey(k) { sessionKey = k; }
function getSessionKey() { return sessionKey; }

function signHeaders(method, pathWithQuery) {
  if (!sessionKey) throw new Error('缺少 sessionKey');
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(12).toString('hex');
  const payload = ['local-v1', method.toUpperCase(), pathWithQuery, ts, nonce].join('\n');
  const signature = crypto.createHmac('sha256', sessionKey).update(payload).digest('base64url');
  return {
    'X-SA-Sign-Version': 'local-v1',
    'X-SA-Timestamp': ts,
    'X-SA-Nonce': nonce,
    'X-SA-Signature': signature,
  };
}

async function kernelCall(method, urlPath, body, timeoutMs = 180000) {
  const headers = signHeaders(method, urlPath);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(KERNEL + urlPath, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: r.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { KERNEL, setSessionKey, getSessionKey, signHeaders, kernelCall };
