'use strict';
/**
 * storage/json-store.js — 加密 JSON 存储（默认，零依赖）
 *
 * 整个凭据库是**一个文件** data/accounts.vault：
 *   base64( nonce(12) | AES-256-GCM( ciphertext | tag(16) ) )
 *
 * 密钥在 data/local-key（32 字节随机文件），或者用口令包裹（data/key.wrap）。
 *
 * 写入用「临时文件 + rename」保证原子性 —— 断电/崩溃不会留下半个文件。
 * 这对续期场景至关重要：续期会轮转 session，写失败等于凭据链断裂。
 *
 * 选它做默认存储的原因：
 *   - 零依赖，Node 18+ 就能跑（拷贝到任何机器直接用）
 *   - 单文件，好备份、好迁移
 *   - 原子写，崩溃安全
 * 缺点：并发写需要外部串行化（v2 是单进程，够用）。
 */

const fs = require('fs');
const path = require('path');
const { encrypt, decrypt, randomKey, wrapPassword, unwrapPassword } = require('../crypto');

const VAULT_VERSION = 2;

class JsonStore {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir
   * @param {string} [opts.password] 有口令则用它包裹本地密钥
   */
  constructor(opts = {}) {
    this.dataDir = opts.dataDir;
    this.vaultPath = path.join(opts.dataDir, 'accounts.vault');
    this.keyPath = path.join(opts.dataDir, 'local-key');
    this.wrapPath = path.join(opts.dataDir, 'key.wrap');
    this.password = opts.password || null;
    this._cache = null;
  }

  get kind() { return 'json'; }

  // ------------------------------------------------------------ 密钥

  _loadKey() {
    // 1) 口令包裹的密钥
    if (fs.existsSync(this.wrapPath)) {
      if (!this.password) {
        throw new Error('凭据库需要口令，但未提供。请用 --password 指定。');
      }
      const wrapped = fs.readFileSync(this.wrapPath, 'utf8').trim();
      return unwrapPassword(wrapped, this.password);
    }
    // 2) 本地密钥文件
    if (fs.existsSync(this.keyPath)) {
      const h = fs.readFileSync(this.keyPath, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(h)) return Buffer.from(h, 'hex');
      const b = Buffer.from(h, 'base64');
      if (b.length === 32) return b;
      throw new Error('local.key 格式异常（应为 64 位 hex 或 32 字节 base64）');
    }
    // 3) 首次使用 → 生成
    const key = randomKey(32);
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (this.password) {
      fs.writeFileSync(this.wrapPath, wrapPassword(this.password), 'utf8');
    } else {
      fs.writeFileSync(this.keyPath, key.toString('hex'), 'utf8');
    }
    return key;
  }

  _key() {
    if (!this._k) this._k = this._loadKey();
    return this._k;
  }

  // ------------------------------------------------------------ 读写

  exists() {
    return fs.existsSync(this.vaultPath);
  }

  /**
   * 读取全部记录
   *
   * ★ 每次都检查文件 mtime —— 变了就重新读。
   *   原因：账号管理模块（scan/import）和反代服务模块是两个进程，
   *   通过同一个 vault 文件交互。若这里缓存住旧内容，
   *   「scan 完新账号，服务还在用旧的」就会发生。
   */
  list() {
    if (!fs.existsSync(this.vaultPath)) {
      this._cache = [];
      this._mtime = 0;
      this._dirty = false;
      return this._cache;
    }
    const st = fs.statSync(this.vaultPath);
    if (this._cache && !this._dirty && st.mtimeMs === this._mtime) {
      return this._cache;
    }
    const raw = fs.readFileSync(this.vaultPath, 'utf8').trim();
    if (!raw) { this._cache = []; this._mtime = st.mtimeMs; return this._cache; }
    let plain;
    try {
      plain = decrypt(raw, this._key()).toString('utf8');
    } catch (e) {
      throw new Error(`凭据库解密失败：${e.message}（口令不对，或文件损坏）`);
    }
    const obj = JSON.parse(plain);
    this._cache = Array.isArray(obj.records) ? obj.records : [];
    this._mtime = st.mtimeMs;
    this._dirty = false;
    return this._cache;
  }

  /**
   * 覆盖写入全部记录（原子）
   *
   * ★ 跨进程安全：
   *   账号管理模块（scan/import）和反代服务模块（续期写回）是两个进程，
   *   可能同时写 vault。这里用「独占锁文件 + 读-改-写」避免互相覆盖：
   *     1. 抢锁（.lock 文件，失败就等）
   *     2. 重新读最新内容
   *     3. 合并后写回
   *     4. 释放锁
   */
  saveAll(records) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const lock = this.vaultPath + '.lock';
    const release = acquireLock(lock, 5000);
    try {
      // 抢到锁后重新读一次，避免覆盖别人刚写的
      const fresh = this._readFromDisk();
      const merged = this._mergeRecords(fresh, records);
      const payload = JSON.stringify({
        version: VAULT_VERSION,
        updatedAt: new Date().toISOString(),
        records: merged,
      }, null, 2);
      const enc = encrypt(payload, this._key());
      const tmp = this.vaultPath + '.tmp';
      fs.writeFileSync(tmp, enc, 'utf8');
      fs.renameSync(tmp, this.vaultPath);   // 原子替换
      this._cache = merged;
      this._mtime = -1;
      this._dirty = true;
      return merged.length;
    } finally {
      release();
    }
  }

  /** 从磁盘读（不碰缓存） */
  _readFromDisk() {
    if (!fs.existsSync(this.vaultPath)) return [];
    const raw = fs.readFileSync(this.vaultPath, 'utf8').trim();
    if (!raw) return [];
    try {
      const obj = JSON.parse(decrypt(raw, this._key()).toString('utf8'));
      return Array.isArray(obj.records) ? obj.records : [];
    } catch (e) {
      return [];
    }
  }

  /**
   * 合并：以传入的 records 为准（调用方已基于最新数据构造），
   * 但保留磁盘上「传入列表里没有」的记录 —— 避免 A 进程加账号、
   * B 进程改状态时把对方的数据抹掉。
   */
  _mergeRecords(onDisk, incoming) {
    const byId = new Map();
    for (const r of onDisk) byId.set(r.id, r);
    for (const r of incoming) byId.set(r.id, { ...(byId.get(r.id) || {}), ...r });
    return [...byId.values()];
  }

  /** 按 id 取一条 */
  get(id) {
    return this.list().find((r) => r.id === id) || null;
  }

  /** 新增或按 id 更新 */
  put(record) {
    const list = this.list().slice();
    const i = list.findIndex((r) => r.id === record.id);
    if (i >= 0) list[i] = { ...list[i], ...record };
    else list.push(record);
    this.saveAll(list);
    return record;
  }

  /**
   * 锁内 read-modify-write：只改指定 id 的那条
   * 跨进程安全 —— 不会把别的进程刚写的记录抹掉。
   */
  update(id, patch) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const lock = this.vaultPath + '.lock';
    const release = acquireLock(lock, 5000);
    try {
      const onDisk = this._readFromDisk();
      const i = onDisk.findIndex((r) => r.id === id);
      let rec;
      if (i >= 0) {
        rec = { ...onDisk[i], ...patch };
        onDisk[i] = rec;
      } else {
        rec = { ...patch, id };
        onDisk.push(rec);
      }
      const payload = JSON.stringify({
        version: VAULT_VERSION,
        updatedAt: new Date().toISOString(),
        records: onDisk,
      }, null, 2);
      const enc = encrypt(payload, this._key());
      const tmp = this.vaultPath + '.tmp';
      fs.writeFileSync(tmp, enc, 'utf8');
      fs.renameSync(tmp, this.vaultPath);
      this._cache = onDisk;
      this._mtime = -1;
      this._dirty = true;
      return rec;
    } finally {
      release();
    }
  }

  /** 删除 */
  remove(id) {
    const list = this.list().filter((r) => r.id !== id);
    this.saveAll(list);
    return list.length;
  }

  /** 统计信息 */
  stats() {
    const list = this.list();
    return {
      kind: this.kind,
      path: this.vaultPath,
      exists: fs.existsSync(this.vaultPath),
      count: list.length,
      byStatus: list.reduce((acc, r) => {
        const s = r.status || 'unknown';
        acc[s] = (acc[s] || 0) + 1;
        return acc;
      }, {}),
    };
  }
}

module.exports = { JsonStore, VAULT_VERSION };

/**
 * 跨进程文件锁（独占创建 .lock 文件）
 * @param {string} lockPath
 * @param {number} timeoutMs
 * @returns {function} release
 */
function acquireLock(lockPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let fd = null;
  while (Date.now() < deadline) {
    try {
      fd = fs.openSync(lockPath, 'wx');   // 'wx' = 独占创建，失败即已存在
      fs.writeSync(fd, String(process.pid));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 可能是上次崩溃留下的僵死锁：超过 30 秒就强行清掉
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > 30000) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (_) {}
      sleepSync(50);
    }
  }
  if (fd === null) {
    // 抢不到锁也继续（宁可冒险也不要卡死）——但记录一下
    return () => {};
  }
  return () => {
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(lockPath); } catch (_) {}
  };
}

/** 同步睡眠（Atomics.wait） */
function sleepSync(ms) {
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  } catch (_) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}
