#!/usr/bin/env node
/**
 * scan-accounts.js — 扫描本机所有 TeleAgent 账号，输出可迁移性评估。
 *
 * 关注四件事：
 *   1. 有哪些账号（users/v1_public_*）
 *   2. 每个账号的 token 能不能解出来
 *   3. token 什么时候过期（决定打包后能用多久）
 *   4. 解密需要的 AES key 是不是所有账号共用（决定一次 setup 能否通吃）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.USERPROFILE || os.homedir();
const DATA = path.join(HOME, '.local', 'share', 'TeleAgent');
const USERS = path.join(DATA, 'users');
const KEY_FILE = path.join(__dirname, '..', 'scripts', 'token.key');

function loadAesKey() {
  try {
    const h = fs.readFileSync(KEY_FILE, 'utf8').trim();
    return /^[0-9a-fA-F]{64}$/.test(h) ? Buffer.from(h, 'hex') : null;
  } catch (_) { return null; }
}

function decryptB64(b64, key) {
  const b = Buffer.from(b64, 'base64');
  if (b.subarray(0, 3).toString('latin1') !== 'v10') throw new Error('非 v10 格式');
  const nonce = b.subarray(3, 15);
  const tag = b.subarray(b.length - 16);
  const ct = b.subarray(15, b.length - 16);
  const d = require('crypto').createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

function readDeviceMeta() {
  const cands = [
    path.join(DATA, 'app-auth', 'device-meta.json'),
    path.join(DATA, 'device-meta.json'),
    path.join(process.env.APPDATA || '', 'TeleAgent', 'app-auth', 'device-meta.json'),
  ];
  for (const p of cands) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j && (j.deviceId || j.installId)) return { path: p, ...j };
    } catch (_) {}
  }
  return null;
}

function main() {
  console.log('=== TeleAgent 账号扫描 ===\n');

  const key = loadAesKey();
  console.log('AES key (token.key):', key ? '已就绪（' + KEY_FILE + '）' : '缺失 → 需先跑 setup.py');
  console.log('');

  if (!fs.existsSync(USERS)) {
    console.log('没有账号目录：' + USERS);
    return;
  }

  const accts = fs.readdirSync(USERS).filter((d) => d.startsWith('v1_public_'));
  console.log('发现账号目录 ' + accts.length + ' 个\n');

  const dm = readDeviceMeta();
  console.log('机器指纹（全局，与账号无关）：');
  console.log('  deviceId :', dm ? dm.deviceId : '(未找到)');
  console.log('  installId:', dm ? dm.installId : '(未找到)');
  console.log('');

  const results = [];
  for (const d of accts) {
    const tj = path.join(USERS, d, 'app-auth', 'token.json');
    if (!fs.existsSync(tj)) {
      results.push({ dir: d, status: '无 token.json' });
      continue;
    }
    const meta = { dir: d, status: 'ok' };
    try {
      const j = JSON.parse(fs.readFileSync(tj, 'utf8'));
      if (!key) { meta.status = '无 AES key，无法解密'; results.push(meta); continue; }
      const token = decryptB64(j.encryptedToken, key).trim();
      const [tenant, ...rest] = token.split(':');
      const jwt = rest.join(':');
      meta.tenant = tenant;
      meta.tokenLen = token.length;
      const segs = jwt.split('.');
      if (segs.length === 3) {
        const pl = JSON.parse(Buffer.from(segs[1], 'base64url').toString('utf8'));
        meta.exp = pl.exp;
        meta.abs = pl.abs;
        meta.accountName = pl.accountName || pl.userName;
        meta.accountId = pl.accountId;
        meta.jwtSig = segs[2];
        meta.expLeftH = Math.round((pl.exp - Date.now() / 1000) / 3600);
      }
    } catch (e) {
      meta.status = '解密失败: ' + e.message;
    }
    results.push(meta);
  }

  const fmt = (t) => (t ? new Date(t * 1000).toLocaleString('zh-CN') : '-');

  console.log('账号明细：');
  for (const r of results) {
    console.log('  ──────────────────────────────────────────');
    console.log('  目录       :', r.dir);
    console.log('  状态       :', r.status);
    if (r.tenant) {
      console.log('  tenant     :', r.tenant);
      console.log('  账号名     :', r.accountName || '(payload 无此字段)');
      console.log('  accountId  :', r.accountId || '-');
      console.log('  token 长度 :', r.tokenLen);
      console.log('  过期(exp)  :', fmt(r.exp), '  剩余 ' + r.expLeftH + ' 小时');
      console.log('  绝对(abs)  :', fmt(r.abs));
      console.log('  可迁移性   : ★ 明文 token 可打包到任意设备（指纹可伪造）');
    }
  }
  console.log('  ──────────────────────────────────────────');

  const ok = results.filter((r) => r.status === 'ok');
  console.log('\n小结：');
  console.log('  可用账号 ' + ok.length + ' / ' + accts.length);
  if (ok.length) {
    const minExp = Math.min(...ok.map((r) => r.expLeftH));
    console.log('  最短有效期 ' + minExp + ' 小时');
    console.log('  → 打包到别的设备后，token 到期前都能用');
    console.log('  → 到期需重新登录 TeleAgent 刷新（renewal-schedule.json 表明 App 会自动续期）');
  }
}

main();
