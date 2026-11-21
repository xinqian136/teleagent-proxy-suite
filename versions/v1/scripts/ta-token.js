#!/usr/bin/env node
/**
 * ta-token.js — 解出 TeleAgent 登录令牌（X-Token）。
 *
 * 3.0.1 的 token.json:
 *   { version, encryptedToken: "<base64>", encrypted: true, scheme: "safe_storage",
 *     encryptedMeta: "<base64>" }
 *
 * encryptedToken 解开后是 "<tenant>:<JWT>"，形如 Em9xR4:eyJhbGciOi...
 * encryptedMeta 解开后是 JSON，含 deviceId / installId。
 *
 * 依赖：token.key（safeStorage 的 AES key，由 setup.py 用 DPAPI 解出）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HOME = process.env.USERPROFILE || os.homedir();
const DATA = path.join(HOME, '.local', 'share', 'TeleAgent');
const KEY_FILE = path.join(__dirname, 'token.key');

function loadAesKey() {
  const h = fs.readFileSync(KEY_FILE, 'utf8').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error('token.key 格式错误（需 64 位 hex）');
  return Buffer.from(h, 'hex');
}

function decryptB64(b64, key) {
  const b = Buffer.from(b64, 'base64');
  // safe_storage v10: 'v10' | 12B nonce | ciphertext | 16B tag
  const prefix = b.subarray(0, 3).toString('latin1');
  if (prefix !== 'v10') throw new Error('未知加密前缀: ' + prefix);
  const nonce = b.subarray(3, 15);
  const tag = b.subarray(b.length - 16);
  const ct = b.subarray(15, b.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

function findAccountDir() {
  const users = path.join(DATA, 'users');
  const ds = fs.readdirSync(users).filter(d => d.startsWith('v1_public_'));
  const withToken = ds.map(d => {
    let mt = -1;
    try { mt = fs.statSync(path.join(users, d, 'app-auth', 'token.json')).mtimeMs; } catch (_) {}
    return { d, mt };
  }).filter(x => x.mt >= 0).sort((a, b) => b.mt - a.mt);
  return withToken.length ? withToken[0].d : (ds[0] || null);
}

function getToken() {
  const key = loadAesKey();
  const acct = findAccountDir();
  if (!acct) throw new Error('找不到账号目录');
  const tj = JSON.parse(fs.readFileSync(path.join(DATA, 'users', acct, 'app-auth', 'token.json'), 'utf8'));
  const token = decryptB64(tj.encryptedToken, key).trim();
  let meta = {};
  if (tj.encryptedMeta) {
    try { meta = JSON.parse(decryptB64(tj.encryptedMeta, key)); } catch (e) { meta = { _err: e.message }; }
  }
  return { account: acct, token, meta };
}

function getDeviceMeta() {
  const cands = [
    path.join(DATA, 'app-auth', 'device-meta.json'),
    path.join(DATA, 'users', findAccountDir() || '', 'app-auth', 'device-meta.json'),
    path.join(process.env.APPDATA || '', 'TeleAgent', 'app-auth', 'device-meta.json'),
  ];
  for (const f of cands) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j && (j.deviceId || j.installId)) return j;
    } catch (_) {}
  }
  return {};
}

module.exports = { getToken, getDeviceMeta, decryptB64, loadAesKey, DATA };

if (require.main === module) {
  try {
    const { account, token, meta } = getToken();
    console.log('account  :', account);
    console.log('token    :', token.slice(0, 40) + '...');
    const parts = token.split(':');
    console.log('tenant   :', parts[0]);
    const jwt = parts.slice(1).join(':');
    const segs = jwt.split('.');
    console.log('jwt 段数 :', segs.length);
    console.log('jwt sig段:', segs[2] ? segs[2].slice(0, 20) + '...' : '(无)');
    // 解 payload
    if (segs[1]) {
      const payload = JSON.parse(Buffer.from(segs[1], 'base64url').toString('utf8'));
      console.log('jwt payload:', JSON.stringify(payload));
    }
    console.log('meta     :', JSON.stringify(meta));
    console.log('deviceMeta:', JSON.stringify(getDeviceMeta()));
  } catch (e) {
    console.error('ERR', e.message);
    process.exit(1);
  }
}
