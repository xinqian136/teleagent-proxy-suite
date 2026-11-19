'use strict';
/**
 * proxy/pool.js — 账号池
 *
 * 职责：
 *   - 从 store 读可用账号
 *   - 轮询分配（默认）/ 加权 / 优先指定
 *   - 记录使用情况
 *   - 账号失效时标记并摘除（不影响其它账号）
 *
 * 设备指纹：每台机器本地随机生成，不复用原机器的 deviceId/installId。
 *   原因：服务端不校验指纹（已实测全随机仍 200），
 *   同一账号在多台机器上用时，服务端看到的是不同客户端，不触发同设备关联。
 */

const crypto = require('crypto');
const { evaluate, STATUS } = require('../account-manager/model');

class AccountPool {
  /**
   * @param {object} opts
   * @param {object} opts.store
   * @param {string} [opts.deviceId]
   * @param {string} [opts.installId]
   */
  constructor(opts = {}) {
    this.store = opts.store;
    this.deviceId = opts.deviceId || generateDeviceId();
    this.installId = opts.installId || crypto.randomUUID();
    this._cursor = 0;
  }

  /** 当前所有账号（含不可用的） */
  all() {
    return this.store.list();
  }

  /** 可用账号 */
  usable() {
    const now = Date.now();
    return this.store.list().filter((r) => {
      if (r.status === STATUS.DISABLED) return false;
      const ev = evaluate(r, now);
      return ev.usable;
    });
  }

  /**
   * 取一个账号用于本次请求
   * @param {object} [opts] { accountId: 指定 }
   * @returns {object|null}
   */
  pick(opts = {}) {
    if (opts.accountId) {
      const r = this.store.get(opts.accountId);
      if (!r) return null;
      const ev = evaluate(r);
      if (!ev.usable) return null;
      this._markUsed(r.id);
      return r;
    }
    const list = this.usable();
    if (!list.length) return null;
    // 轮询
    const r = list[this._cursor % list.length];
    this._cursor = (this._cursor + 1) % list.length;
    this._markUsed(r.id);
    return r;
  }

  /** 标记账号刚被用过 */
  _markUsed(id) {
    if (typeof this.store.update === 'function') {
      this.store.update(id, { lastUsedAt: Date.now() });
    } else {
      const r = this.store.get(id);
      if (r) this.store.put({ ...r, lastUsedAt: Date.now() });
    }
  }

  /**
   * 报告一次失败
   * @param {string} id
   * @param {object} err { status, code, message, fatal }
   */
  reportFailure(id, err) {
    const r = this.store.get(id);
    if (!r) return null;
    const fatal = err.fatal || [40112, 40113, 40115, 40116].includes(err.code);
    const patch = {
      status: fatal ? STATUS.NEEDS_RELOGIN : r.status,
      lastError: `${err.code || err.status || '?'} ${err.message || ''}`.trim(),
      updatedAt: Date.now(),
    };
    return typeof this.store.update === 'function'
      ? this.store.update(id, patch)
      : this.store.put({ ...r, ...patch });
  }

  /** 报告一次成功（顺带刷新有效期信息） */
  reportSuccess(id, extra = {}) {
    const r = this.store.get(id);
    if (!r) return null;
    const patch = {
      status: STATUS.ACTIVE,
      lastError: null,
      updatedAt: Date.now(),
      ...extra,
    };
    return typeof this.store.update === 'function'
      ? this.store.update(id, patch)
      : this.store.put({ ...r, ...patch });
  }

  /** 池的状态摘要 */
  summary() {
    const list = this.all();
    const now = Date.now();
    return {
      total: list.length,
      usable: this.usable().length,
      needsRelogin: list.filter((r) => r.status === STATUS.NEEDS_RELOGIN).length,
      disabled: list.filter((r) => r.status === STATUS.DISABLED).length,
      expiringSoon: list.filter((r) => {
        const sec = Math.floor(now / 1000);
        return r.expiresAt && r.expiresAt - sec < 24 * 3600;
      }).length,
      deviceId: this.deviceId,
      installId: this.installId,
    };
  }
}

/** 生成设备 ID（12 位十六进制，与 TeleAgent 格式一致） */
function generateDeviceId() {
  return crypto.randomBytes(6).toString('hex');
}

module.exports = { AccountPool, generateDeviceId };
