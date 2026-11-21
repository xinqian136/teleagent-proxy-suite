/**
 * ta-gw-sign.js — TeleAgent 3.0.1 云网关签名（方案 A 用）
 *
 * 算法来源：从 3.0.1 内核二进制反汇编还原
 *   code.srdcloud.cn/AI-Cloud/super-agent-code/internal/infra/einoprovider.(*GatewaySigner).Sign
 *   @0x140d9a2e0 (go1.26.5, PE x64)
 *
 * 还原要点（与 2.5.0 时代文档的差异已标注）：
 *   ① 头名是 `X-SuperAgent-*`（大写 A），不是 `X-Superagent-*`
 *   ② 第二轮的 scheme 是 strings.ToUpper("superagent-auth-v1") = "SUPERAGENT-AUTH-V1"
 *   ③ 密钥 = JWT 第三段（jwtThirdSegment 用 '.' 分割）
 *   ④ hmacHex 输出小写 hex
 *
 * 第一轮（5 段，分隔符 "/"）：
 *   m1 = "superagent-auth-v1/{token}/{installId}/{ts}/{nonce}"
 *   sig1 = hex(HMAC_SHA256(K, m1))          K = JWT 第三段
 *
 * 第二轮（7 段，分隔符 "\n"）：
 *   m2 = "SUPERAGENT-AUTH-V1\n{method}\n{path}\n{ts}\n{nonce}\n{appVersion}\n{bodyHash}"
 *   sig = hex(HMAC_SHA256(sig1, m2))         bodyHash = hex(SHA256(body))
 *
 * ts 单位：秒
 */

const crypto = require('crypto');

const SCHEME_LOWER = 'superagent-auth-v1';
const SCHEME_UPPER = 'SUPERAGENT-AUTH-V1';

/** 取 JWT 第三段（签名段） */
function jwtThirdSegment(token) {
  // token 形如 "<tenant>:<jwt>"
  const jwt = token.split(':').slice(1).join(':');
  const segs = jwt.split('.');
  if (segs.length < 3) throw new Error('token 不是合法的 JWT（段数 ' + segs.length + '）');
  return segs[2];
}

function hmacHex(key, msg) {
  return crypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex');
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 计算网关签名
 * @param {string} token      "<tenant>:<JWT>"
 * @param {string} method     "POST"
 * @param {string} signPath   参与签名的路径，如 /superCowork/sapi/api/v1/chat/completions
 * @param {number} tsSec      秒级时间戳
 * @param {string} nonce      随机串
 * @param {Buffer|string} body 实际发出的请求体原始字节（必须与真正发出的完全一致）
 * @param {string} installId
 * @param {string} appVersion
 * @param {string} variant    第二轮段序变体：
 *        'v1'  = ["SUPERAGENT-AUTH-V1", method, path, ts, nonce, appVersion, bodyHash]  （2.5.0 文档版）
 *        'v2'  = ["superagent-auth-v1", "SUPERAGENT-AUTH-V1", method, path, ts, nonce, bodyHash]（3.0.1 反汇编：scheme 小写在前 + 大写）
 *        'v3'  = ["superagent-auth-v1", method, path, ts, nonce, appVersion, bodyHash]（小写单 scheme）
 */
function computeSignature(token, method, signPath, tsSec, nonce, body, installId, appVersion, variant = 'v2') {
  const K = jwtThirdSegment(token);
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body || '', 'utf8');
  const bodyHash = sha256Hex(bodyBuf);

  // 第一轮：'/' 分隔，5 段
  const m1 = [SCHEME_LOWER, token, installId, String(tsSec), nonce].join('/');
  const sig1 = hmacHex(K, m1);

  // 第二轮：'\n' 分隔
  let parts;
  if (variant === 'v1') {
    parts = [SCHEME_UPPER, String(method).toUpperCase(), signPath, String(tsSec), nonce, appVersion, bodyHash];
  } else if (variant === 'v3') {
    parts = [SCHEME_LOWER, String(method).toUpperCase(), signPath, String(tsSec), nonce, appVersion, bodyHash];
  } else { // v2
    parts = [SCHEME_LOWER, SCHEME_UPPER, String(method).toUpperCase(), signPath, String(tsSec), nonce, bodyHash];
  }
  const m2 = parts.join('\n');
  return hmacHex(sig1, m2);
}

/** 生成构建请求头所需的全部材料 */
function buildAuth(token, method, signPath, body, installId, appVersion) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body || '', 'utf8');
  const signature = computeSignature(token, method, signPath, ts, nonce, bodyBuf, installId, appVersion);
  return { ts, nonce, signature, bodyBuf };
}

module.exports = { computeSignature, buildAuth, jwtThirdSegment, hmacHex, sha256Hex, SCHEME_LOWER, SCHEME_UPPER };

if (require.main === module) {
  // 自检：用已知 token 验证结构
  const { getToken, getDeviceMeta } = require('./ta-token');
  const { account, token } = getToken();
  const dm = getDeviceMeta();
  const appVersion = process.env.TA_APP_VERSION || '3.0.1';
  const body = JSON.stringify({ model: 'chat-pro', messages: [{ role: 'user', content: 'hi' }] });
  const r = buildAuth(token, 'POST', '/superCowork/sapi/api/v1/chat/completions', body, dm.installId, appVersion);
  console.log('account   :', account);
  console.log('tenant    :', token.split(':')[0]);
  console.log('installId :', dm.installId);
  console.log('deviceId  :', dm.deviceId);
  console.log('ts        :', r.ts);
  console.log('nonce     :', r.nonce);
  console.log('signature :', r.signature);
  console.log('bodyHash  :', sha256Hex(r.bodyBuf));
}
