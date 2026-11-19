'use strict';
/**
 * account-manager/importer.js — 导入账号
 *
 * 支持：
 *   bundle  由 exporter 导出的打包文件（可跨机器）
 *   xlsx    人工在 Excel 里整理好的账号表（只有元信息，token 需另配）
 *   json    简单格式 [{tenant, token, ...}]
 *
 * 导入 xlsx/json 时如果只有元信息没有 token，账号会被标记为 needsRelogin，
 * 等你在原机器上补充。
 */

const fs = require('fs');
const path = require('path');
const { decrypt, deriveKeyFromPassword } = require('../crypto');
const xlsx = require('../xlsx');
const { fromToken, parseToken, STATUS } = require('./model');

/** 读 bundle 文件并解出账号记录 */
function readBundle(filePath, opts = {}) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error('不是有效的 bundle 文件（JSON 解析失败）');
  }

  let payload = obj;
  if (obj.format === 'teleagent-proxy-v2-bundle-encrypted') {
    if (!opts.password) {
      throw new Error('该 bundle 已加密，需要提供口令（--password）');
    }
    const salt = Buffer.from(obj.salt, 'base64');
    const { key } = deriveKeyFromPassword(opts.password, salt);
    payload = JSON.parse(decrypt(obj.payload, key).toString('utf8'));
  }

  if (payload.format !== 'teleagent-proxy-v2-bundle') {
    throw new Error(`不是 teleagent-proxy bundle（format=${payload.format || '未知'}）`);
  }

  const records = [];
  const errors = [];
  for (const a of payload.accounts || []) {
    try {
      const key = Buffer.from(a.localKey, 'base64');
      const token = decrypt(a.encryptedToken, key).toString('utf8');
      const rec = fromToken(token, { source: 'bundle', note: a.note || '' });
      records.push({
        ...rec,
        id: a.id || rec.id,
        tenant: a.tenant || rec.tenant,
        accountId: a.accountId || rec.accountId,
        accountName: a.accountName || rec.accountName,
        expiresAt: a.expiresAt || rec.expiresAt,
        absoluteExpiresAt: a.absoluteExpiresAt || rec.absoluteExpiresAt,
      });
    } catch (e) {
      errors.push({ message: `账号 ${a.accountName || a.id} 解密失败：${e.message}` });
    }
  }
  return { records, errors, meta: { createdAt: payload.createdAt, version: payload.version } };
}

/** 读 xlsx 账号表（只有元信息） */
function readXlsx(filePath) {
  const { headers, rows } = xlsx.read(filePath);
  const idx = {};
  headers.forEach((h, i) => { idx[h.toLowerCase()] = i; });
  const pick = (row, ...names) => {
    for (const n of names) {
      const i = idx[n.toLowerCase()];
      if (i !== undefined && row[i] !== undefined && row[i] !== '') return row[i];
    }
    return '';
  };

  const records = [];
  const errors = [];
  rows.forEach((row, ri) => {
    const token = pick(row, 'token', '令牌');
    const tenant = pick(row, 'tenant');
    const accountName = pick(row, '账号名', 'accountname', 'name');
    const accountId = pick(row, 'accountid');
    if (!token && !tenant && !accountId) return;   // 空行
    if (!token) {
      errors.push({ message: `第 ${ri + 2} 行没有 token 列，跳过（需在原机器补齐）` });
      return;
    }
    const full = token.includes(':') ? token : `${tenant}:${token}`;
    const rec = fromToken(full, { source: 'import-xlsx' });
    rec.accountName = accountName || rec.accountName;
    rec.accountId = accountId || rec.accountId;
    const expStr = pick(row, '过期时间', 'expiresat');
    if (expStr) {
      const t = Date.parse(expStr);
      if (!Number.isNaN(t)) rec.expiresAt = Math.floor(t / 1000);
    }
    records.push(rec);
  });
  return { records, errors };
}

/** 读 json 数组 */
function readJson(filePath) {
  const obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const arr = Array.isArray(obj) ? obj : (obj.accounts || []);
  const records = [];
  const errors = [];
  arr.forEach((a, i) => {
    if (!a.token) { errors.push({ message: `第 ${i + 1} 条没有 token，跳过` }); return; }
    const full = String(a.token).includes(':') ? String(a.token) : `${a.tenant || ''}:${a.token}`;
    const rec = fromToken(full, { source: 'import-json', note: a.note || '' });
    rec.accountName = a.accountName || a.account_name || rec.accountName;
    rec.accountId = a.accountId || a.account_id || rec.accountId;
    records.push(rec);
  });
  return { records, errors };
}

/**
 * 统一入口
 * @param {string} filePath
 * @param {object} opts { password, format }
 */
function importFromFile(filePath, opts = {}) {
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在：${filePath}`);
  const ext = path.extname(filePath).toLowerCase();

  let format = opts.format;
  if (!format) {
    if (ext === '.xlsx') format = 'xlsx';
    else if (ext === '.json') format = 'json';
    else if (ext === '.bundle') format = 'bundle';
    else {
      // 尝试按 bundle 解析
      try {
        const r = readBundle(filePath, opts);
        return { ...r, format: 'bundle' };
      } catch (e) {
        throw new Error(`无法识别的文件类型（${ext || '无扩展名'}）：${e.message}`);
      }
    }
  }

  if (format === 'bundle') return { ...readBundle(filePath, opts), format };
  if (format === 'xlsx') return { ...readXlsx(filePath), format };
  if (format === 'json') return { ...readJson(filePath), format };
  throw new Error(`未知导入格式：${format}（可用：bundle / xlsx / json）`);
}

/**
 * 导入并合并进 store
 * @param {object} store
 * @param {string} filePath
 * @param {object} opts
 */
function importInto(store, filePath, opts = {}) {
  const r = importFromFile(filePath, opts);
  const added = [], updated = [];

  for (const rec of r.records) {
    const existing = store.list().find(
      (x) => (x.accountId && x.accountId === rec.accountId) ||
             (x.tenant && x.tenant === rec.tenant && !rec.accountId)
    );
    if (existing) {
      updated.push(store.put({
        ...existing,
        token: rec.token,
        expiresAt: rec.expiresAt,
        absoluteExpiresAt: rec.absoluteExpiresAt,
        accountName: rec.accountName || existing.accountName,
        status: STATUS.ACTIVE,
        lastError: null,
        updatedAt: Date.now(),
      }));
    } else {
      added.push(store.put(rec));
    }
  }
  return { ...r, added, updated };
}

module.exports = { importFromFile, importInto, readBundle, readXlsx, readJson };
