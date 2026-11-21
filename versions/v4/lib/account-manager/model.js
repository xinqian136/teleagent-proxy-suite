'use strict';
/**
 * account-manager/model.js — 账号数据模型
 *
 * 一个账号记录长这样：
 * {
 *   id: 'acc_xxx',              // 本地 ID
 *   tenant: 'I7Kp2X',
 *   accountId: '1903017686270410753',
 *   accountName: '曾星熠',
 *   token: 'I7Kp2X:eyJhbGciOi...',   // 明文令牌（存储时加密）
 *   status: 'active' | 'needsRelogin' | 'disabled',
 *   expiresAt: 1794991469,      // Unix 秒
 *   absoluteExpiresAt: 1797553,  // Unix 秒，90 天硬期限
 *   source: 'scan' | 'import' | 'bundle',
 *   note: '',
 *   createdAt / updatedAt / lastUsedAt / lastError
 * }
 */

const { randomId } = require('../crypto');

const STATUS = {
  ACTIVE: 'active',
  NEEDS_RELOGIN: 'needsRelogin',
  DISABLED: 'disabled',
};

/** 解析 token（格式 tenant:JWT） */
function parseToken(token) {
  const t = String(token || '').trim();
  const idx = t.indexOf(':');
  if (idx < 0) return { tenant: null, payload: null };
  const tenant = t.slice(0, idx);
  const jwt = t.slice(idx + 1);
  try {
    const seg = jwt.split('.');
    if (seg.length !== 3) return { tenant, payload: null };
    const payload = JSON.parse(Buffer.from(seg[1], 'base64url').toString('utf8'));
    return { tenant, payload };
  } catch (e) {
    return { tenant, payload: null };
  }
}

/** 从 token 构造一条账号记录 */
function fromToken(token, extra = {}) {
  const { tenant, payload } = parseToken(token);
  return {
    id: extra.id || randomId('acc'),
    tenant: tenant || null,
    accountId: payload?.accountId || null,
    accountName: payload?.accountName || payload?.userName || null,
    token: String(token).trim(),
    status: STATUS.ACTIVE,
    expiresAt: payload?.exp || null,
    absoluteExpiresAt: payload?.abs || null,
    source: extra.source || 'scan',
    note: extra.note || '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastError: null,
    lastUsedAt: null,
  };
}

/** 判断账号当前是否可用 */
function evaluate(rec, now = Date.now()) {
  const sec = Math.floor(now / 1000);
  if (!rec.token) return { usable: false, reason: 'no-token', status: STATUS.NEEDS_RELOGIN };
  if (rec.expiresAt && sec >= rec.expiresAt) {
    return { usable: false, reason: 'expired', status: STATUS.NEEDS_RELOGIN };
  }
  if (rec.absoluteExpiresAt && sec >= rec.absoluteExpiresAt) {
    return { usable: false, reason: 'absolute-expired', status: STATUS.NEEDS_RELOGIN };
  }
  if (rec.status === STATUS.DISABLED) {
    return { usable: false, reason: 'disabled', status: STATUS.DISABLED };
  }
  return { usable: true, reason: null, status: STATUS.ACTIVE };
}

/** 剩余有效期描述 */
function describe(rec, now = Date.now()) {
  const sec = Math.floor(now / 1000);
  if (!rec.expiresAt) return '未知';
  const left = rec.expiresAt - sec;
  if (left <= 0) return '已过期';
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  if (d > 0) return `${d} 天 ${h} 小时`;
  const m = Math.floor((left % 3600) / 60);
  return `${h} 小时 ${m} 分`;
}

/** 绝对期限剩余描述 */
function describeAbsolute(rec, now = Date.now()) {
  const sec = Math.floor(now / 1000);
  if (!rec.absoluteExpiresAt) return '未知';
  const left = rec.absoluteExpiresAt - sec;
  if (left <= 0) return '已到期';
  return `${Math.floor(left / 86400)} 天`;
}

module.exports = { STATUS, parseToken, fromToken, evaluate, describe, describeAbsolute };
