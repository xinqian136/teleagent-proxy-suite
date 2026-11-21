'use strict';
/**
 * proxy/signer.js — 网关请求签名
 *
 * 逆向自 TeleAgent 内核 einoprovider.(*GatewaySigner).Sign
 *
 * 两轮 HMAC-SHA256：
 *   第一轮（分隔符 '/'，5 段）：
 *     m1   = "superagent-auth-v1/{token}/{installId}/{ts}/{nonce}"
 *     sig1 = hex(HMAC_SHA256(K, m1))            K = JWT 第三段
 *   第二轮（分隔符 '\n'，7 段）：
 *     m2   = "superagent-auth-v1\n{method}\n{path}\n{ts}\n{nonce}\n{appVersion}\n{bodyHash}"
 *     sig  = hex(HMAC_SHA256(sig1, m2))         bodyHash = hex(SHA256(body 原始字节))
 *
 * 要点：
 *   - scheme 全程小写（3.0.1 / 3.1.0 实际行为）
 *   - nonce 不可重用，服务端记 nonce，重复返回 40105
 *   - appVersion 参与签名，但服务端只校验格式（x.y.z），不校验具体值
 */

const crypto = require('crypto');

const SCHEME = 'superagent-auth-v1';

/** 从 token 里取 JWT 第三段（HMAC 密钥） */
function jwtThirdSegment(token) {
  const t = String(token);
  const i = t.indexOf(':');
  const jwt = i >= 0 ? t.slice(i + 1) : t;
  const seg = jwt.split('.');
  if (seg.length < 3) throw new Error('token 格式异常，取不到 JWT 第三段');
  return seg[2];
}

function hmacHex(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 计算签名
 * @param {object} o
 * @param {string} o.token
 * @param {string} o.method
 * @param {string} o.path      含 query string 的完整 RequestURI
 * @param {number} o.ts        Unix 秒
 * @param {string} o.nonce
 * @param {Buffer|string} o.body 实际发出的请求体字节
 * @param {string} o.installId
 * @param {string} o.appVersion
 * @returns {string} hex 签名
 */
function computeSignature(o) {
  const K = jwtThirdSegment(o.token);
  const bodyBuf = Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body || '', 'utf8');
  const bodyHash = sha256Hex(bodyBuf);
  const ts = String(o.ts);

  const m1 = [SCHEME, o.token, o.installId, ts, o.nonce].join('/');
  const sig1 = hmacHex(K, m1);

  const m2 = [SCHEME, String(o.method).toUpperCase(), o.path, ts, o.nonce, o.appVersion, bodyHash].join('\n');
  return hmacHex(sig1, m2);
}

/**
 * 生成一整套请求头（含签名）
 */
function buildHeaders(o) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const bodyBuf = Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body || '', 'utf8');

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'User-Agent': 'super-agent/1.0',
    'Authorization': 'Bearer ' + o.channelKey,
    'X-Token': o.token,
    'X-Route-Target': 'ops-gateway',
    'X-Runtime-Env': 'ctyun_pc',
    'X-App-Version': o.appVersion || '3.1.0',
    'X-SuperAgent-Timestamp': String(ts),
    'X-SuperAgent-Nonce': nonce,
    'X-SuperAgent-Device-Id': o.deviceId || '',
    'X-SuperAgent-Install-Id': o.installId || '',
    'X-SuperAgent-Sign-Version': 'v1',
  };

  headers['X-SuperAgent-Signature'] = computeSignature({
    token: o.token,
    method: o.method || 'POST',
    path: o.path,
    ts,
    nonce,
    body: bodyBuf,
    installId: o.installId || '',
    appVersion: o.appVersion || '3.1.0',
  });

  return headers;
}

module.exports = { computeSignature, buildHeaders, jwtThirdSegment, SCHEME };
