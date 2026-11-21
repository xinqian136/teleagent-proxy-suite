'use strict';
/**
 * proxy/refresher.js — 凭证续期循环
 *
 * 策略：
 *   - 定时：每 N 小时检查一次（默认 6 小时），剩余 < 24h 就续
 *   - 即时：请求遇到 40114 / 40105 时立刻续期并重试一次
 *   - 连续失败 3 次 → 标记 needsRelogin（终止性错误直接标记）
 *
 * ★ 续期会轮转 session：拿到新 token 必须立刻落盘。
 *   写回失败 → 保留旧 token 降级（宁可晚点死，也不能把链子彻底断掉）。
 *   这里用 store.put（内部是临时文件 + rename 的原子写）。
 *
 * 错误码：
 *   40112 MISSING_ACCESS_TOKEN      终止 → 需重登
 *   40113 SIGNATURE_INVALID         终止 → 需重登
 *   40114 TOKEN_EXPIRED             可续期
 *   40115 SESSION_NOT_FOUND         终止 → 需重登
 *   40116 SESSION_ABSOLUTE_EXPIRED  终止 → 需重登（90 天硬期限）
 *   50005 TEMPORARILY_UNAVAILABLE   可重试
 */

const { refreshToken } = require('./gateway');
const { evaluate, STATUS } = require('../account-manager/model');

const TERMINAL_CODES = [40112, 40113, 40115, 40116];
const RETRYABLE_CODES = [40114, 50005, 40105];

class Refresher {
  /**
   * @param {object} opts
   * @param {object} opts.store
   * @param {object} opts.pool
   * @param {string} opts.channelKey
   * @param {number} [opts.intervalMs]     检查间隔，默认 6 小时
   * @param {number} [opts.aheadSeconds]   剩余多少秒就续，默认 24 小时
   * @param {function} [opts.log]
   */
  constructor(opts = {}) {
    this.store = opts.store;
    this.pool = opts.pool;
    this.channelKey = opts.channelKey;
    this.intervalMs = opts.intervalMs || 6 * 3600 * 1000;
    this.aheadSeconds = opts.aheadSeconds || 24 * 3600;
    this.appVersion = opts.appVersion || '3.1.0';
    this.log = opts.log || (() => {});
    this.timer = null;
    this._running = false;
    this._failCount = new Map();
  }

  start() {
    if (this.timer) return;
    this.log(`[续期] 已启动，间隔 ${Math.round(this.intervalMs / 60000)} 分钟`);
    // 启动后延迟一点再跑首轮，避免和进程启动抢资源
    setTimeout(() => this.tick(), 5000);
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** 跑一轮：给所有快过期的账号续期 */
  async tick() {
    if (this._running) return;
    this._running = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      const targets = this.store.list().filter((r) => {
        if (r.status === STATUS.DISABLED) return false;
        if (!r.expiresAt) return false;
        return r.expiresAt - now < this.aheadSeconds;
      });
      if (!targets.length) return;
      this.log(`[续期] ${targets.length} 个账号即将到期，开始续期`);
      for (const r of targets) {
        await this.refreshOne(r.id, '定时');
      }
    } catch (e) {
      this.log(`[续期] 轮次异常：${e.message}`);
    } finally {
      this._running = false;
    }
  }

  /**
   * 续期一个账号
   * @param {string} id
   * @param {string} reason
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async refreshOne(id, reason = '手动') {
    const rec = this.store.get(id);
    if (!rec) return { ok: false, reason: '账号不存在' };
    if (!rec.token) return { ok: false, reason: '无 token' };

    const r = await refreshToken({
      token: rec.token,
      deviceId: this.pool.deviceId,
      appVersion: this.appVersion,
    });

    if (!r.ok) {
      const code = r.code;
      const fatal = TERMINAL_CODES.includes(code);
      const n = (this._failCount.get(id) || 0) + 1;
      this._failCount.set(id, n);

      if (fatal || n >= 3) {
        this._patch(rec.id, {
          status: STATUS.NEEDS_RELOGIN,
          lastError: `${code || '?'} ${r.message || ''}`.trim(),
          updatedAt: Date.now(),
        });
        this.log(`[续期] 账号 ${rec.accountName || id} 需要重新登录（${code || '?'} ${r.message || ''}）`);
        return { ok: false, reason: 'needs-relogin', code };
      }
      this._patch(rec.id, {
        lastError: `${code || '?'} ${r.message || ''}`.trim(),
        updatedAt: Date.now(),
      });
      this.log(`[续期] 账号 ${rec.accountName || id} 续期失败（第 ${n} 次）：${code || '?'} ${r.message || ''}`);
      return { ok: false, reason: 'retry', code };
    }

    // ★ 拿到新 token，立刻落盘（原子写由 store 内部保证）
    try {
      this._patch(rec.id, {
        token: r.token,
        status: STATUS.ACTIVE,
        lastError: null,
        updatedAt: Date.now(),
      });
      this._failCount.delete(id);
      this.log(`[续期] 账号 ${rec.accountName || id} 续期成功（${reason}）`);
      return { ok: true };
    } catch (e) {
      // 写回失败：保留旧 token（降级），不要丢链子
      this.log(`[续期] 账号 ${rec.accountName || id} 新 token 写回失败（${e.message}），保留旧 token`);
      return { ok: false, reason: 'persist-failed', error: e.message };
    }
  }

  /** 原子更新一条账号（跨进程安全） */
  _patch(id, patch) {
    if (typeof this.store.update === 'function') return this.store.update(id, patch);
    const rec = this.store.get(id);
    return rec ? this.store.put({ ...rec, ...patch }) : null;
  }

  /**
   * 请求前调用：确保拿到的账号 token 是新鲜的
   * @param {object} rec
   * @returns {Promise<object>} 可能被更新过的账号记录
   */
  async ensureFresh(rec) {
    const ev = evaluate(rec);
    if (ev.usable) return rec;
    // 不可用 → 试续期
    const r = await this.refreshOne(rec.id, '请求前');
    if (r.ok) return this.store.get(rec.id) || rec;
    return rec;
  }

  /** 判断某个错误码是否值得立刻重试 */
  static isRetryable(code) {
    return RETRYABLE_CODES.includes(code);
  }

  static isTerminal(code) {
    return TERMINAL_CODES.includes(code);
  }
}

module.exports = { Refresher, TERMINAL_CODES, RETRYABLE_CODES };
