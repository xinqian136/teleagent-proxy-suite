'use strict';
/**
 * web/settings.js — 设置持久化
 *
 * 存 config/settings.json，改了立即生效（端口/API Key 变化会热重载反代）。
 *
 * 设置项：
 *   web.port / web.host     Web 后台监听
 *   proxy.port / proxy.host 反代监听
 *   proxy.apiKey            反代鉴权密钥
 *   proxy.autoStart         Web 启动时是否自动起反代
 *   storage                 存储类型 json | sqlite
 *   refresher.*             续期参数
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  web: {
    port: 8796,
    host: '127.0.0.1',
    openBrowser: true,
  },
  proxy: {
    port: 8793,
    host: '127.0.0.1',
    apiKey: 'teleagent-local',
    autoStart: true,
    paused: false,          // 持久化暂停：重启后台后也不自动起反代
    visionFallback: true,   // 带图请求遇「模型不支持视觉」时自动降级到 chat-flash
  },
  storage: 'json',
  refresher: {
    intervalMinutes: 360,
    aheadHours: 24,
  },
  appVersion: '3.1.0',
};

class Settings {
  constructor(opts = {}) {
    this.file = opts.file || path.join(opts.configDir || '.', 'settings.json');
    this._data = null;
  }

  get data() {
    if (this._data) return this._data;
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (_) {}
    this._data = deepMerge(deepMerge({}, DEFAULTS), raw);
    return this._data;
  }

  /** 取设置（支持 'proxy.port' 这种点号路径） */
  get(pathStr) {
    const parts = pathStr.split('.');
    let v = this.data;
    for (const p of parts) {
      if (v === undefined || v === null) return undefined;
      v = v[p];
    }
    return v;
  }

  /** 改设置并落盘 */
  set(pathStr, value) {
    const parts = pathStr.split('.');
    const d = this.data;
    let cur = d;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
    this.save();
    return d;
  }

  /**
   * 批量改
   * 支持两种写法：
   *   patch({ 'proxy.port': 8793 })          ← 点号路径
   *   patch({ proxy: { port: 8793 } })        ← 嵌套对象
   */
  patch(obj) {
    const d = this.data;
    for (const [k, v] of Object.entries(obj || {})) {
      if (k.includes('.')) {
        const parts = k.split('.');
        let cur = d;
        for (let i = 0; i < parts.length - 1; i++) {
          if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
          cur = cur[parts[i]];
        }
        cur[parts[parts.length - 1]] = v;
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        deepMerge(cur_k(d, k), v);
      } else {
        d[k] = v;
      }
    }
    this.save();
    return d;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /** 恢复默认 */
  reset() {
    this._data = deepMerge({}, DEFAULTS);
    this.save();
    return this._data;
  }

  /** 校验端口合法性 */
  static validPort(p) {
    const n = Number(p);
    return Number.isInteger(n) && n > 0 && n < 65536;
  }
}

function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== 'object') target[k] = {};
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

/** 取顶层键（用于 patch 的嵌套分支） */
function cur_k(d, k) {
  if (!d[k] || typeof d[k] !== 'object') d[k] = {};
  return d[k];
}

module.exports = { Settings, DEFAULTS, deepMerge };
