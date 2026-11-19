'use strict';
/**
 * crypto.js — 加密工具（零依赖）
 *
 * 全部基于 Node 内置 crypto：
 *   - AES-256-GCM 对称加密（凭据库、账号包）
 *   - scrypt 口令派生
 *   - HMAC-SHA256（网关签名用，见 signer.js）
 *
 * 密文格式统一为：base64( nonce(12) | ciphertext | tag(16) )
 */

const crypto = require('crypto');

const NONCE_LEN = 12;
const TAG_LEN = 16;
const ALGO = 'aes-256-gcm';

function randomKey(len = 32) {
  return crypto.randomBytes(len);
}

function randomId(prefix = '') {
  const id = crypto.randomBytes(9).toString('base64url');
  return prefix ? `${prefix}_${id}` : id;
}

/**
 * AES-256-GCM 加密
 * @param {string|Buffer} plaintext
 * @param {Buffer} key 32 字节
 * @returns {string} base64(nonce|ct|tag)
 */
function encrypt(plaintext, key) {
  assertKey(key);
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, nonce);
  const ct = Buffer.concat([
    cipher.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8')),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString('base64');
}

/**
 * AES-256-GCM 解密
 * @param {string} b64 base64(nonce|ct|tag)
 * @param {Buffer} key 32 字节
 * @returns {Buffer}
 */
function decrypt(b64, key) {
  assertKey(key);
  const b = Buffer.from(b64, 'base64');
  if (b.length <= NONCE_LEN + TAG_LEN) throw new Error('密文长度异常');
  const nonce = b.subarray(0, NONCE_LEN);
  const tag = b.subarray(b.length - TAG_LEN);
  const ct = b.subarray(NONCE_LEN, b.length - TAG_LEN);
  const d = crypto.createDecipheriv(ALGO, key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/** 口令 → 32 字节 key（scrypt，带随机盐） */
function deriveKeyFromPassword(password, salt) {
  const s = Buffer.isBuffer(salt) ? salt : crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), s, 32, { N: 16384, r: 8, p: 1 });
  return { key, salt: s };
}

/** 带盐的口令封装：base64(salt16|key32) */
function wrapPassword(password) {
  const { key, salt } = deriveKeyFromPassword(password);
  return Buffer.concat([salt, key]).toString('base64');
}

/** 解开 wrapPassword 的结果 */
function unwrapPassword(wrapped, password) {
  const b = Buffer.from(wrapped, 'base64');
  if (b.length < 48) throw new Error('口令封装格式异常');
  const salt = b.subarray(0, 16);
  const key = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
  return key;
}

function hmacHex(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error(`密钥必须是 32 字节，实际 ${key && key.length}`);
  }
}

module.exports = {
  ALGO, NONCE_LEN, TAG_LEN,
  randomKey, randomId,
  encrypt, decrypt,
  deriveKeyFromPassword, wrapPassword, unwrapPassword,
  hmacHex, sha256Hex,
};
