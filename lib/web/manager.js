'use strict';
/**
 * web/manager.js — 反代生命周期管理（可热启停）
 *
 * Web 后台持有这个 manager：
 *   改端口 → stop() + start()，立即用新端口跑起来
 *   改 API Key → 同样重启生效
 *
 * 反代服务与 Web 后台在同一个进程里，Web 关了反代也关 —— 这是有意的：
 * 避免两个独立进程各管一份凭据、互相踩。
 */

const { AccountPool } = require('../proxy/pool');
const { Refresher } = require('../proxy/refresher');
const { createServer } = require('../proxy/server');
const { resolveChannelKey } = require('../proxy/gateway');

class ProxyManager {
  /**
   * @param {object} opts
   * @param {object} opts.store
   * @param {object} opts.settings
   * @param {string} opts.root       程序根目录
   * @param {function} opts.log
   */
  constructor(opts = {}) {
    this.store = opts.store;
    this.settings = opts.settings;
    this.root = opts.root;
    this.log = opts.log || (() => {});
    this.server = null;
    this.refresher = null;
    this.pool = null;
    this.state = 'stopped';   // stopped | starting | running | error
    this.error = null;
    this.startedAt = null;
  }

  /** 反代配置快照 */
  cfg() {
    return {
      port: this.settings.get('proxy.port'),
      host: this.settings.get('proxy.host'),
      apiKey: this.settings.get('proxy.apiKey'),
      appVersion: this.settings.get('appVersion') || '3.1.0',
    };
  }

  isRunning() {
    return this.state === 'running';
  }

  /** 启动反代 */
  async start() {
    if (this.state === 'running' || this.state === 'starting') {
      return { ok: true, already: true };
    }
    const c = this.cfg();
    this.state = 'starting';
    this.error = null;

    try {
      const ck = resolveChannelKey({
        configDir: require('path').join(this.root, 'config'),
        dataDir: require('path').join(this.root, 'data'),
      });
      if (!ck.key) {
        throw new Error('找不到渠道密钥。请在「账号」页点「扫描」，或导入账号包。');
      }
      this.channelKey = ck.key;
      this.channelKeySource = ck.source;

      this.pool = new AccountPool({ store: this.store });
      this.refresher = new Refresher({
        store: this.store,
        pool: this.pool,
        channelKey: ck.key,
        intervalMs: (this.settings.get('refresher.intervalMinutes') || 360) * 60000,
        aheadSeconds: (this.settings.get('refresher.aheadHours') || 24) * 3600,
        appVersion: c.appVersion,
        log: (m) => this.log(m),
      });

      this.server = createServer({
        store: this.store,
        pool: this.pool,
        refresher: this.refresher,
        channelKey: ck.key,
        apiKey: c.apiKey,
        appVersion: c.appVersion,
        log: (m) => this.log(m),
        recordFile: require('path').join(this.root, 'data', 'requests.log'),
      });

      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(c.port, c.host, resolve);
      });

      this.refresher.start();
      this.state = 'running';
      this.startedAt = Date.now();
      this.log(`[反代] 已启动 http://${c.host}:${c.port}/v1`);
      return { ok: true };
    } catch (e) {
      this.state = 'error';
      this.error = e.message;
      this.log(`[反代] 启动失败：${e.message}`);
      try { if (this.server) this.server.close(); } catch (_) {}
      this.server = null;
      return { ok: false, error: e.message };
    }
  }

  /** 停止反代 */
  async stop() {
    if (this.refresher) this.refresher.stop();
    if (this.server) {
      await new Promise((resolve) => {
        try { this.server.close(() => resolve()); }
        catch (_) { resolve(); }
        setTimeout(resolve, 2000);
      });
    }
    this.server = null;
    this.refresher = null;
    this.state = 'stopped';
    this.startedAt = null;
    this.log('[反代] 已停止');
    return { ok: true };
  }

  /** 重启（改了端口/API Key 后调用） */
  async restart() {
    await this.stop();
    await new Promise((r) => setTimeout(r, 500));
    return this.start();
  }

  /** 状态摘要 */
  status() {
    const c = this.cfg();
    return {
      state: this.state,
      error: this.error,
      port: c.port,
      host: c.host,
      apiKey: c.apiKey,
      appVersion: c.appVersion,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      channelKeyFound: !!this.channelKey,
      channelKeySource: this.channelKeySource || null,
      accounts: this.pool ? this.pool.summary() : null,
    };
  }

  /** 供外部（如 Web 端自己）使用的反代服务实例 */
  get instance() {
    return { server: this.server, pool: this.pool, refresher: this.refresher, cfg: this.cfg() };
  }
}

module.exports = { ProxyManager };
