'use strict';
/**
 * storage/index.js — 存储工厂
 *
 * 账号管理模块和反代服务模块都只通过这里读写，两边不直接耦合。
 *
 *   storage = createStore({ dataDir, kind, password })
 *   storage.list() / get(id) / put(rec) / remove(id) / saveAll(list) / stats()
 *
 * kind:
 *   'json'   默认。零依赖，Node 18+ 都能跑，单文件，原子写。
 *   'sqlite' 可选。需要 Node 22+（内置 node:sqlite，无原生模块）。
 */

const path = require('path');
const { JsonStore } = require('./json-store');

function createStore(opts = {}) {
  const dataDir = opts.dataDir || path.join(process.cwd(), 'data');
  const kind = (opts.kind || 'json').toLowerCase();

  if (kind === 'json') {
    return new JsonStore({ dataDir, password: opts.password });
  }
  if (kind === 'sqlite') {
    const { SqliteStore } = require('./sqlite-store');
    return new SqliteStore({ dataDir });
  }
  throw new Error(`未知存储类型：${kind}（可用：json / sqlite）`);
}

module.exports = { createStore, JsonStore };
