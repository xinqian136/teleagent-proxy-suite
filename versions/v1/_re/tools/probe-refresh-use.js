#!/usr/bin/env node
/**
 * probe-refresh-use.js — 验证「续期后的新 token」能直接用于网关推理请求。
 *
 * 这是 v2 的最后一环：
 *   扫描到 token → 续期 → 用新 token 反代 → 全程不依赖 TeleAgent App
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HOME = process.env.USERPROFILE || os.homedir();
const DATA = path.join(HOME, '.local', 'share', 'TeleAgent');
const BASE = 'https://agent.teleai.com.cn/superCowork/sapi';
const GATEWAY = BASE + '/api/v1/chat/completions';
const SIGN_PATH = '/superCowork/sapi/api/v1/chat/completions';

function loadAesKey() {
  for (const p of [path.join(__dirname, '..', 'scripts', 'token.key'),
                   path.join(__dirname, '..', '..', 'scripts', 'token.key')]) {
    try {
      const h = fs.readFileSync(p, 'utf8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(h)) return Buffer.from(h, 'hex');
    } catch (_) {}
  }
  return null;
}
function decryptB64(b64, key) {
  const b = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(3, 15));
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(15, b.length - 16)), d.final()]).toString('utf8');
}
function findAccountDir() {
  const users = path.join(DATA, 'users');
  if (!fs.existsSync(users)) return null;
  return fs.readdirSync(users).filter((d) => d.startsWith('v1_public_'))
    .map((d) => { try { return { d, mt: fs.statSync(path.join(users, d, 'app-auth', 'token.json')).mtimeMs }; } catch (_) { return { d, mt: -1 }; } })
    .filter((x) => x.mt >= 0).sort((a, b) => b.mt - a.mt)[0]?.d || null;
}
function channelKey() {
  if (process.env.TA_CHANNEL_KEY) return process.env.TA_CHANNEL_KEY;
  const p = 'C:/Program Files/TeleAgent/resources/app.asar';
  if (!fs.existsSync(p)) return null;
  const fd = fs.openSync(p, 'r');
  const CH = 1 << 22; const buf = Buffer.alloc(CH); let pos = 0, tail = '', found = null;
  while (found === null) {
    const n = fs.readSync(fd, buf, 0, CH, pos);
    if (n <= 0) break;
    const s = tail + buf.toString('latin1', 0, n);
    const m = s.match(/sk-[A-Za-z0-9]{20,32}/);
    if (m) { found = m[0]; break; }
    tail = s.slice(-64); pos += n;
  }
  fs.closeSync(fd);
  return found;
}
function jwtPayload(token) {
  try {
    const jwt = token.split(':').slice(1).join(':');
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
  } catch (_) { return {}; }
}
function hmacHex(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}
function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function refresh(token, deviceId) {
  const r = await fetch(BASE + '/cowork/auth/token-refresh', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Token': token,
      'X-Timestamp': Math.floor(Date.now() / 1000).toString(),
      'X-Nonce': crypto.randomUUID(),
      'X-App-Version': '3.0.1',
      'X-OS-Type': 'Windows',
      'X-SuperAgent-Device-Id': deviceId,
    },
    body: '',
    signal: AbortSignal.timeout(30000),
  });
  const t = await r.text();
  if (r.status !== 200) return { ok: false, status: r.status, text: t.slice(0, 200) };
  let j = null; try { j = JSON.parse(t); } catch (_) {}
  const at = j && (j.data && j.data.accessToken || j.accessToken);
  return at ? { ok: true, token: at } : { ok: false, status: r.status, text: t.slice(0, 200) };
}

async function chat(token, ck, installId, deviceId, text) {
  const body = JSON.stringify({ model: 'chat-flash', messages: [{ role: 'user', content: text }], stream: false });
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const K = token.split(':').slice(1).join(':').split('.')[2];
  const sig1 = hmacHex(K, ['superagent-auth-v1', token, installId, String(ts), nonce].join('/'));
  const bodyHash = sha256Hex(Buffer.from(body, 'utf8'));
  const m2 = ['superagent-auth-v1', 'POST', SIGN_PATH, String(ts), nonce, '3.0.1', bodyHash].join('\n');
  const sig = hmacHex(sig1, m2);
  const r = await fetch(GATEWAY, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'Accept': 'text/event-stream',
      'User-Agent': 'super-agent/1.0',
      'Authorization': 'Bearer ' + ck,
      'X-Token': token,
      'X-Route-Target': 'ops-gateway', 'X-Runtime-Env': 'ctyun_pc',
      'X-App-Version': '3.0.1',
      'X-SuperAgent-Timestamp': String(ts), 'X-SuperAgent-Nonce': nonce,
      'X-SuperAgent-Device-Id': deviceId, 'X-SuperAgent-Install-Id': installId,
      'X-SuperAgent-Sign-Version': 'v1',
      'X-SuperAgent-Signature': sig,
    },
    body,
    signal: AbortSignal.timeout(60000),
  });
  const t = await r.text();
  if (r.status !== 200) return { ok: false, status: r.status, text: t.slice(0, 200) };
  let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { ok: true, content: j && j.choices[0].message.content };
}

(async () => {
  console.log('=== 全链路验证：扫描 → 续期 → 反代 ===\n');
  const acct = findAccountDir();
  const key = loadAesKey();
  const tj = JSON.parse(fs.readFileSync(path.join(DATA, 'users', acct, 'app-auth', 'token.json'), 'utf8'));
  const oldToken = decryptB64(tj.encryptedToken, key).trim();
  const ck = channelKey();
  console.log('账号:', acct);
  console.log('渠道密钥:', ck ? ck.slice(0, 8) + '…' : '(未找到，需要 app.asar)');
  console.log();

  // 用全新的随机指纹（模拟换设备）
  const deviceId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const installId = crypto.randomUUID();
  console.log('新设备指纹: deviceId=%s installId=%s', deviceId, installId);
  console.log();

  console.log('--- 步骤1: 续期 ---');
  const ref = await refresh(oldToken, deviceId);
  if (!ref.ok) { console.log('续期失败:', ref.status, ref.text); return; }
  const np = jwtPayload(ref.token);
  console.log('✓ 续期成功，新 token 过期:', new Date(np.exp * 1000).toLocaleString('zh-CN'));
  console.log('  与旧 token 相同?', ref.token === oldToken ? '是（未轮转）' : '否（已轮转）');
  console.log();

  console.log('--- 步骤2: 用新 token + 新指纹反代 ---');
  const ch = await chat(ref.token, ck, installId, deviceId, '用一句话说你是谁');
  if (!ch.ok) { console.log('推理失败:', ch.status, ch.text); return; }
  console.log('✓ 推理成功:', String(ch.content).trim().slice(0, 120));
  console.log();
  console.log('=== 结论 ===');
  console.log('✓ 续期接口可独立调用（不依赖 App）');
  console.log('✓ 新 token 直接可用于网关');
  console.log('✓ 全新设备指纹可用');
  console.log('→ v2 可完全自持：扫一次 token，之后自己续期，永不需要 TeleAgent App');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
