#!/usr/bin/env node
/**
 * probe-refresh.js — 验证 token 续期接口能否独立调用。
 *
 * 逆向自 app.asar：
 *   base = https://agent.teleai.com.cn/superCowork/sapi
 *   path = /cowork/auth/token-refresh
 *   头   = X-Token(当前token) + X-Timestamp + X-Nonce + X-App-Version
 *          + X-OS-Type + X-SuperAgent-Device-Id
 *   body = 空
 *   响应 = { accessToken, expiresIn }
 *
 * 若这条能通 → v2 可以自己做续期，彻底不依赖 TeleAgent App。
 *
 * 用法: node probe-refresh.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HOME = process.env.USERPROFILE || os.homedir();
const DATA = path.join(HOME, '.local', 'share', 'TeleAgent');
const BASE = 'https://agent.teleai.com.cn/superCowork/sapi';
const REFRESH_PATH = '/cowork/auth/token-refresh';

function findAccountDir() {
  const users = path.join(DATA, 'users');
  if (!fs.existsSync(users)) return null;
  const ds = fs.readdirSync(users)
    .filter((d) => d.startsWith('v1_public_'))
    .map((d) => {
      const p = path.join(users, d, 'app-auth', 'token.json');
      let mt = -1;
      try { mt = fs.statSync(p).mtimeMs; } catch (_) {}
      return { d, mt };
    })
    .filter((x) => x.mt >= 0)
    .sort((a, b) => b.mt - a.mt);
  return ds.length ? ds[0].d : null;
}

function loadAesKey() {
  for (const p of [
    path.join(__dirname, '..', 'scripts', 'token.key'),
    path.join(__dirname, '..', '..', 'scripts', 'token.key'),
  ]) {
    try {
      const h = fs.readFileSync(p, 'utf8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(h)) return Buffer.from(h, 'hex');
    } catch (_) {}
  }
  return null;
}

function decryptB64(b64, key) {
  const b = Buffer.from(b64, 'base64');
  const nonce = b.subarray(3, 15);
  const tag = b.subarray(b.length - 16);
  const ct = b.subarray(15, b.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

function readDeviceMeta() {
  const cands = [
    path.join(DATA, 'app-auth', 'device-meta.json'),
    path.join(DATA, 'device-meta.json'),
  ];
  for (const p of cands) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j && j.deviceId) return j;
    } catch (_) {}
  }
  return { deviceId: '', installId: '' };
}

(async () => {
  console.log('=== 续期接口验证 ===\n');

  const acct = findAccountDir();
  if (!acct) { console.log('找不到账号目录'); return; }
  const key = loadAesKey();
  if (!key) { console.log('找不到 token.key'); return; }

  const tj = JSON.parse(fs.readFileSync(
    path.join(DATA, 'users', acct, 'app-auth', 'token.json'), 'utf8'));
  const token = decryptB64(tj.encryptedToken, key).trim();
  const dm = readDeviceMeta();

  const pl = JSON.parse(Buffer.from(
    token.split(':').slice(1).join(':').split('.')[1], 'base64url').toString('utf8'));
  console.log('账号目录 :', acct);
  console.log('当前 token 过期时间:', new Date(pl.exp * 1000).toLocaleString('zh-CN'));
  console.log('剩余:', Math.round((pl.exp - Date.now() / 1000) / 3600), '小时');
  console.log();

  // 构造续期请求
  const headers = {
    'Content-Type': 'application/json',
    'X-Token': token,
    'X-Timestamp': Math.floor(Date.now() / 1000).toString(),
    'X-Nonce': crypto.randomUUID(),
    'X-App-Version': '3.0.1',
    'X-OS-Type': 'Windows',
    'X-SuperAgent-Device-Id': dm.deviceId || '00ff36d4f305',
  };

  console.log('POST ' + BASE + REFRESH_PATH);
  console.log('头:', JSON.stringify(headers, null, 1).replace(token.slice(0, 30), token.slice(0, 30) + '…'));
  console.log();

  try {
    const r = await fetch(BASE + REFRESH_PATH, {
      method: 'POST', headers, body: '',
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    console.log('HTTP', r.status);
    console.log('响应:', text.slice(0, 600));
    console.log();
    if (r.status === 200) {
      let j = null;
      try { j = JSON.parse(text); } catch (_) {}
      const at = j && (j.accessToken || (j.data && j.data.accessToken));
      if (at) {
        console.log('✓ 拿到 accessToken，长度', at.length);
        const np = JSON.parse(Buffer.from(
          at.split(':').slice(1).join(':').split('.')[1], 'base64url').toString('utf8'));
        console.log('  新 token 过期:', new Date(np.exp * 1000).toLocaleString('zh-CN'));
        console.log('  → 续期可用，v2 可自建续期循环');
      }
    }
  } catch (e) {
    console.log('ERR', e.message);
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
