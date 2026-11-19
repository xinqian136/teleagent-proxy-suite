'use strict';
/**
 * account-manager/scanner.js — 扫描本机 TeleAgent 账号
 *
 * 扫的是**数据目录**，不是安装位置：
 *   %USERPROFILE%\.local\share\TeleAgent\users\v1_public_*\app-auth\token.json
 *
 * token.json 有两种加密方案：
 *   safe_storage → 密钥在 Local State → DPAPI（绑定 Windows 用户+机器）
 *                   → 本机能解，别的机器解不开
 *   local        → 密钥在同目录 local-key（纯随机文件）→ 可复制到别的机器
 *
 * 扫描结果里带上 scheme 与可迁移性标记，供 export 时决定怎么打包。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readAesKey } = require('../dpapi');
const { fromToken, parseToken } = require('./model');

/** TeleAgent 数据目录 */
function teleAgentDataDir() {
  return process.env.TA_DATA_DIR ||
    path.join(process.env.USERPROFILE || os.homedir(), '.local', 'share', 'TeleAgent');
}

/**
 * 列出本机所有账号目录
 * @returns {string[]} 账号目录名
 */
function listAccountDirs(dataDir) {
  const users = path.join(dataDir, 'users');
  if (!fs.existsSync(users)) return [];
  return fs.readdirSync(users).filter((d) => d.startsWith('v1_public_'));
}

/**
 * 读设备指纹（机器级）
 */
function readDeviceMeta(dataDir) {
  const cands = [
    path.join(dataDir, 'app-auth', 'device-meta.json'),
    path.join(dataDir, 'device-meta.json'),
  ];
  for (const p of cands) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j && (j.deviceId || j.installId)) {
        return { deviceId: j.deviceId || '', installId: j.installId || '', path: p };
      }
    } catch (_) {}
  }
  return { deviceId: '', installId: '', path: null };
}

/** 解 safe_storage 密文（v10|nonce12|ct|tag16） */
function decryptSafeStorage(b64, aesKey) {
  const b = Buffer.from(b64, 'base64');
  if (b.subarray(0, 3).toString('latin1') !== 'v10') throw new Error('非 v10 格式');
  const nonce = b.subarray(3, 15);
  const tag = b.subarray(b.length - 16);
  const ct = b.subarray(15, b.length - 16);
  const d = require('crypto').createDecipheriv('aes-256-gcm', aesKey, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/** 解 local 密文（nonce12|ct|tag16） */
function decryptLocal(b64, key) {
  const b = Buffer.from(b64, 'base64');
  const nonce = b.subarray(0, 12);
  const tag = b.subarray(b.length - 16);
  const ct = b.subarray(12, b.length - 16);
  const d = require('crypto').createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/**
 * 扫描本机账号
 * @param {object} opts
 * @param {string} [opts.dataDir] TeleAgent 数据目录
 * @returns {{accounts:Array, deviceMeta:object, dataDir:string, errors:Array}}
 */
function scan(opts = {}) {
  const dataDir = opts.dataDir || teleAgentDataDir();
  const result = { accounts: [], deviceMeta: null, dataDir, errors: [] };

  if (!fs.existsSync(dataDir)) {
    result.errors.push({
      code: 'no-data-dir',
      message: `找不到 TeleAgent 数据目录：${dataDir}`,
      hint: '本机可能没装 TeleAgent，或从未登录过。可用 `tav2 import` 导入账号包。',
    });
    return result;
  }

  const dirs = listAccountDirs(dataDir);
  if (!dirs.length) {
    result.errors.push({
      code: 'no-accounts',
      message: '数据目录里没有账号（users/ 下无 v1_public_* ）',
      hint: '在 TeleAgent 里登录一次即可。',
    });
    result.deviceMeta = readDeviceMeta(dataDir);
    return result;
  }

  result.deviceMeta = readDeviceMeta(dataDir);

  // safe_storage 的 AES key（惰性取，失败也不影响 local 账号）
  let aesKey = null;
  const lsPath = path.join(dataDir, 'Local State');
  if (fs.existsSync(lsPath)) {
    aesKey = readAesKey(lsPath);
    if (!aesKey) {
      result.errors.push({
        code: 'dpapi-failed',
        message: 'Local State 的 DPAPI 解密失败',
        hint: '凭据绑定当前 Windows 用户 + 机器，换用户/换机器解不开是正常的。',
      });
    }
  }

  for (const d of dirs) {
    const appAuth = path.join(dataDir, 'users', d, 'app-auth');
    const tjPath = path.join(appAuth, 'token.json');
    if (!fs.existsSync(tjPath)) {
      result.errors.push({ code: 'no-token', message: `${d}: 无 token.json` });
      continue;
    }

    let tj;
    try {
      tj = JSON.parse(fs.readFileSync(tjPath, 'utf8'));
    } catch (e) {
      result.errors.push({ code: 'bad-json', message: `${d}: token.json 解析失败` });
      continue;
    }

    const scheme = tj.scheme || 'safe_storage';
    let token = null;
    let portable = false;
    let localKeyB64 = null;

    try {
      if (scheme === 'local') {
        const lkPath = path.join(appAuth, 'local-key');
        if (!fs.existsSync(lkPath)) throw new Error('缺 local-key');
        const key = fs.readFileSync(lkPath);
        token = decryptLocal(tj.encryptedToken, key);
        localKeyB64 = key.toString('base64');
        portable = true;   // local 方案可移植
      } else {
        if (!aesKey) throw new Error('无法获取 AES key（DPAPI 不匹配）');
        token = decryptSafeStorage(tj.encryptedToken, aesKey);
        portable = false;  // safe_storage 绑定机器
      }
    } catch (e) {
      result.errors.push({
        code: 'decrypt-failed',
        message: `${d}: 解密失败（${e.message}）`,
        hint: scheme === 'local'
          ? 'local-key 可能损坏或与 token.json 不匹配。'
          : 'safe_storage 绑定当前 Windows 用户 + 机器，无法在别的机器解开。',
        accountDir: d,
        scheme,
      });
      continue;
    }

    const rec = fromToken(token, { source: 'scan', note: '' });
    rec.accountDir = d;
    rec.scheme = scheme;
    rec.portable = portable;
    rec.localKey = localKeyB64;         // 仅 local 方案有，供 export 用
    rec.deviceId = result.deviceMeta.deviceId;
    rec.installId = result.deviceMeta.installId;

    // 若存储里已有同账号，保留原有的 id 与备注
    result.accounts.push(rec);
  }

  return result;
}

/**
 * 扫描并合并进 store（按 tenant+accountId 去重，优先保留新 token）
 * @param {object} store
 * @param {object} [opts]
 * @returns {{added:Array, updated:Array, skipped:Array, errors:Array}}
 */
function scanInto(store, opts = {}) {
  const r = scan(opts);
  const added = [], updated = [], skipped = [];

  for (const rec of r.accounts) {
    const existing = store.list().find(
      (x) => (x.accountId && x.accountId === rec.accountId) ||
             (x.tenant && x.tenant === rec.tenant && !rec.accountId)
    );
    if (existing) {
      // 已存在 → 更新 token 与有效期，保留 id/note
      const merged = store.put({
        ...existing,
        token: rec.token,
        expiresAt: rec.expiresAt,
        absoluteExpiresAt: rec.absoluteExpiresAt,
        accountName: rec.accountName || existing.accountName,
        status: 'active',
        lastError: null,
        updatedAt: Date.now(),
      });
      updated.push(merged);
    } else {
      // 新账号：保留 fromToken 生成的 id，去掉仅扫描时用到的临时字段
      const { localKey, accountDir, scheme, portable, deviceId, installId, ...clean } = rec;
      added.push(store.put({ ...clean, source: 'scan' }));
    }
  }

  return { added, updated, skipped, errors: r.errors, deviceMeta: r.deviceMeta };
}

module.exports = { scan, scanInto, listAccountDirs, readDeviceMeta, teleAgentDataDir, decryptLocal, decryptSafeStorage };
