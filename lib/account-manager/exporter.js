'use strict';
/**
 * account-manager/exporter.js — 导出账号
 *
 * 三种格式：
 *   bundle  打包带走用。含明文 token（用 local 方案加密），跨机器可用。
 *   xlsx    给人工看/改。**不含 token**，只有元信息。
 *   csv     同上，Excel 也能直接打开。
 *
 * ⚠️ bundle 等同于账号密码。默认会用口令加密；不给口令时明文但会警告。
 */

const fs = require('fs');
const path = require('path');
const { encrypt, decrypt, randomKey, deriveKeyFromPassword } = require('../crypto');
const xlsx = require('../xlsx');
const { describe, describeAbsolute, evaluate } = require('./model');

const BUNDLE_VERSION = 2;

/** 导出为 bundle（可跨机器） */
function exportBundle(records, opts = {}) {
  const password = opts.password || null;
  const now = new Date().toISOString();

  // 每个账号：token 用 local 方案加密，配一把独立的随机密钥
  const accounts = records.map((r) => {
    const localKey = randomKey(32);
    const encToken = encrypt(r.token, localKey);
    return {
      id: r.id,
      tenant: r.tenant,
      accountId: r.accountId,
      accountName: r.accountName,
      expiresAt: r.expiresAt,
      absoluteExpiresAt: r.absoluteExpiresAt,
      note: r.note || '',
      encryptedToken: encToken,
      localKey: localKey.toString('base64'),
    };
  });

  const payload = {
    format: 'teleagent-proxy-v2-bundle',
    version: BUNDLE_VERSION,
    createdAt: now,
    accounts,
  };

  // 渠道密钥（所有用户共用）—— 一起打包，目标机就不用手工配了
  if (opts.channelKey) {
    payload.channelKey = opts.channelKey;
  }

  let body;
  let encrypted = false;
  if (password) {
    // 口令直接派生对称密钥（scrypt + 随机盐），盐随包保存
    const { key, salt } = deriveKeyFromPassword(password);
    const encPayload = encrypt(JSON.stringify(payload), key);
    body = JSON.stringify({
      format: 'teleagent-proxy-v2-bundle-encrypted',
      version: BUNDLE_VERSION,
      createdAt: now,
      kdf: 'scrypt',
      salt: salt.toString('base64'),
      payload: encPayload,
    });
    encrypted = true;
  } else {
    body = JSON.stringify(payload, null, 2);
  }

  if (opts.outPath) {
    fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
    fs.writeFileSync(opts.outPath, body, 'utf8');
  }

  return {
    format: 'bundle',
    encrypted,
    content: body,
    count: records.length,
    outPath: opts.outPath || null,
  };
}

/** 导出为 xlsx（元信息，不含 token） */
function exportXlsx(records, opts = {}) {
  const headers = [
    'ID', '账号名', 'tenant', 'accountId',
    '过期时间', '剩余有效期', '绝对期限', '绝对期限剩余',
    '状态', '来源', '备注',
  ];
  const rows = records.map((r) => {
    const ev = evaluate(r);
    return [
      r.id,
      r.accountName || '',
      r.tenant || '',
      r.accountId || '',
      r.expiresAt ? new Date(r.expiresAt * 1000).toLocaleString('zh-CN') : '',
      describe(r),
      r.absoluteExpiresAt ? new Date(r.absoluteExpiresAt * 1000).toLocaleString('zh-CN') : '',
      describeAbsolute(r),
      r.status || ev.status,
      r.source || '',
      r.note || '',
    ];
  });

  if (opts.outPath) {
    xlsx.write(opts.outPath, headers, rows, '账号');
  }
  return { format: 'xlsx', headers, rows, count: rows.length, outPath: opts.outPath || null };
}

/** 导出为 csv（元信息，不含 token） */
function exportCsv(records) {
  const headers = [
    'id', 'accountName', 'tenant', 'accountId',
    'expiresAt', 'expiresIn', 'absoluteExpiresAt', 'status', 'source', 'note',
  ];
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const r of records) {
    lines.push([
      r.id, r.accountName || '', r.tenant || '', r.accountId || '',
      r.expiresAt ? new Date(r.expiresAt * 1000).toISOString() : '',
      describe(r),
      r.absoluteExpiresAt ? new Date(r.absoluteExpiresAt * 1000).toISOString() : '',
      r.status || 'active', r.source || '', r.note || '',
    ].map(esc).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * 统一入口
 * @param {Array} records
 * @param {object} opts { format:'bundle'|'xlsx'|'csv', outPath, password }
 */
function exportAccounts(records, opts = {}) {
  const format = (opts.format || 'bundle').toLowerCase();
  if (format === 'bundle') return exportBundle(records, opts);
  if (format === 'xlsx') return exportXlsx(records, opts);
  if (format === 'csv') {
    const csv = exportCsv(records);
    if (opts.outPath) {
      fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
      fs.writeFileSync(opts.outPath, csv, 'utf8');
    }
    return { format: 'csv', content: csv, count: records.length, outPath: opts.outPath || null };
  }
  throw new Error(`未知导出格式：${format}（可用：bundle / xlsx / csv）`);
}

module.exports = { exportAccounts, exportBundle, exportXlsx, exportCsv, BUNDLE_VERSION };
