'use strict';
/**
 * storage/sqlite-store.js — SQLite 存储（可选，需要 Node 22+）
 *
 * 用 Node 内置的 node:sqlite（无原生模块编译，换机器不会崩）。
 * 选它而不是 better-sqlite3：后者是原生模块，有 ABI 绑定，
 * 拷到别的机器/别的 Node 版本可能直接崩 —— 与「拷贝即用」的目标冲突。
 *
 * 启用方式：
 *   node bin/tav2.js --db sqlite ...
 * 或在 config 里设 "storage": "sqlite"
 *
 * 注意：Node 20 没有 node:sqlite，用这个存储会直接报错并提示。
 */

const fs = require('fs');
const path = require('path');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  DatabaseSync = null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  tenant        TEXT,
  account_id    TEXT,
  account_name  TEXT,
  token         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  expires_at    INTEGER,
  absolute_expires_at INTEGER,
  source        TEXT,
  note          TEXT,
  created_at    INTEGER,
  updated_at    INTEGER,
  last_error    TEXT,
  last_used_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
`;

class SqliteStore {
  constructor(opts = {}) {
    if (!DatabaseSync) {
      const err = new Error(
        'SQLite 存储需要 Node 22+（内置 node:sqlite）。\n' +
        `当前 Node 版本：${process.version}\n` +
        '改用默认的 JSON 存储即可（零依赖，任何 Node 18+ 都能跑）：\n' +
        '  node bin/tav2.js --db json ...'
      );
      err.code = 'ENOSQLITE';
      throw err;
    }
    this.dataDir = opts.dataDir;
    this.dbPath = path.join(opts.dataDir, 'accounts.db');
    fs.mkdirSync(opts.dataDir, { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  get kind() { return 'sqlite'; }

  exists() {
    return fs.existsSync(this.dbPath);
  }

  _rowToRec(r) {
    if (!r) return null;
    return {
      id: r.id,
      tenant: r.tenant,
      accountId: r.account_id,
      accountName: r.account_name,
      token: r.token,
      status: r.status,
      expiresAt: r.expires_at,
      absoluteExpiresAt: r.absolute_expires_at,
      source: r.source,
      note: r.note,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastError: r.last_error,
      lastUsedAt: r.last_used_at,
    };
  }

  list() {
    const rows = this.db.prepare('SELECT * FROM accounts ORDER BY created_at ASC').all();
    return rows.map((r) => this._rowToRec(r));
  }

  saveAll(records) {
    const now = Date.now();
    const del = this.db.prepare('DELETE FROM accounts');
    const ins = this.db.prepare(`
      INSERT INTO accounts
        (id, tenant, account_id, account_name, token, status, expires_at,
         absolute_expires_at, source, note, created_at, updated_at, last_error, last_used_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    this.db.exec('BEGIN');
    try {
      del.run();
      for (const r of records) {
        ins.run(
          r.id, r.tenant ?? null, r.accountId ?? null, r.accountName ?? null, r.token,
          r.status || 'active', r.expiresAt ?? null, r.absoluteExpiresAt ?? null,
          r.source ?? null, r.note ?? null,
          r.createdAt ?? now, r.updatedAt ?? now, r.lastError ?? null, r.lastUsedAt ?? null
        );
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return records.length;
  }

  get(id) {
    const r = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    return this._rowToRec(r);
  }

  put(record) {
    const now = Date.now();
    const cur = this.get(record.id);
    const merged = { ...(cur || {}), ...record, updatedAt: now, createdAt: cur?.createdAt ?? now };
    this.db.prepare(`
      INSERT INTO accounts
        (id, tenant, account_id, account_name, token, status, expires_at,
         absolute_expires_at, source, note, created_at, updated_at, last_error, last_used_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        tenant=excluded.tenant, account_id=excluded.account_id,
        account_name=excluded.account_name, token=excluded.token,
        status=excluded.status, expires_at=excluded.expires_at,
        absolute_expires_at=excluded.absolute_expires_at, source=excluded.source,
        note=excluded.note, updated_at=excluded.updated_at,
        last_error=excluded.last_error, last_used_at=excluded.last_used_at
    `).run(
      merged.id, merged.tenant ?? null, merged.accountId ?? null, merged.accountName ?? null,
      merged.token, merged.status || 'active', merged.expiresAt ?? null,
      merged.absoluteExpiresAt ?? null, merged.source ?? null, merged.note ?? null,
      merged.createdAt ?? now, now, merged.lastError ?? null, merged.lastUsedAt ?? null
    );
    return merged;
  }

  remove(id) {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    return this.list().length;
  }

  stats() {
    const list = this.list();
    return {
      kind: this.kind,
      path: this.dbPath,
      exists: fs.existsSync(this.dbPath),
      count: list.length,
      byStatus: list.reduce((acc, r) => {
        const s = r.status || 'unknown';
        acc[s] = (acc[s] || 0) + 1;
        return acc;
      }, {}),
    };
  }
}

module.exports = { SqliteStore, sqliteAvailable: () => !!DatabaseSync };
