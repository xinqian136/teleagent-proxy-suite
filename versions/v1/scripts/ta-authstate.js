#!/usr/bin/env node
/**
 * ta-authstate.js — 解密 SUPER_AGENT_AUTH_STATE，得到内核实际使用的登录态。
 *
 * 格式: {"version":"v1","iv":b64,"tag":b64,"ciphertext":b64}
 * 密钥: AES-256-GCM，key = SHA256(sessionKey)
 *
 * 用法: node ta-authstate.js [authStateJson]
 *        不带参数则从内核进程环境里找（需自行传入）
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function b64d(s) {
  // base64url 或标准 base64 都支持
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return Buffer.from(t, 'base64');
}

function decryptAuthState(obj, sessionKey) {
  const key = crypto.createHash('sha256').update(sessionKey, 'utf8').digest();
  const iv = b64d(obj.iv);
  const tag = b64d(obj.tag);
  const ct = b64d(obj.ciphertext);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

if (require.main === module) {
  let raw = process.argv[2];
  if (!raw) {
    // 从 session.key 旁找 auth state（需要外部提供）
    console.error('用法: node ta-authstate.js "<authState json>"');
    process.exit(2);
  }
  const sessionKey = fs.readFileSync(path.join(__dirname, 'session.key'), 'utf8').trim();
  try {
    const obj = JSON.parse(raw);
    const plain = decryptAuthState(obj, sessionKey);
    console.log('=== 解密成功 ===');
    const j = JSON.parse(plain);
    for (const [k, v] of Object.entries(j)) {
      const s = String(v);
      console.log('  %s = %s', k, s.length > 90 ? s.slice(0, 90) + '...' : s);
    }
  } catch (e) {
    console.error('解密失败:', e.message);
  }
}

module.exports = { decryptAuthState };
