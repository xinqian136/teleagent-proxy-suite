#!/usr/bin/env node
'use strict';
/**
 * tav2.js — TeleAgent 反代 v2 统一 CLI
 *
 * 模块划分：
 *   账号管理（account-manager/）：scan / import / export / accounts
 *   反代服务（proxy/）：serve / refresh / doctor / test
 *
 * 两者通过 storage/ 解耦 —— 账号管理只管读写存储，反代只从存储读。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const { createStore } = require(path.join(ROOT, 'lib', 'storage'));
const { scan, scanInto } = require(path.join(ROOT, 'lib', 'account-manager', 'scanner'));
const { exportAccounts } = require(path.join(ROOT, 'lib', 'account-manager', 'exporter'));
const { importInto, importFromFile } = require(path.join(ROOT, 'lib', 'account-manager', 'importer'));
const { evaluate, describe, describeAbsolute, STATUS } = require(path.join(ROOT, 'lib', 'account-manager', 'model'));
const { AccountPool } = require(path.join(ROOT, 'lib', 'proxy', 'pool'));
const { Refresher } = require(path.join(ROOT, 'lib', 'proxy', 'refresher'));
const { resolveChannelKey } = require(path.join(ROOT, 'lib', 'proxy', 'gateway'));
const { createServer } = require(path.join(ROOT, 'lib', 'proxy', 'server'));
const { createLogger } = require(path.join(ROOT, 'lib', 'proxy', 'logger'));

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) { flags[a.slice(2)] = next; i++; }
        else flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  // 位置参数用 _，选项直接摊在顶层（args.out / args.password ...）
  return Object.assign({ _: positional }, flags);
}

function loadConfig(flags) {
  const cfgPath = flags.config
    ? path.resolve(flags.config)
    : path.join(ROOT, 'config', 'default.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (_) {}
  if (flags.port) cfg.port = parseInt(flags.port, 10);
  if (flags.host) cfg.host = flags.host;
  if (flags.db) cfg.storage = flags.db;
  if (flags['api-key']) cfg.apiKey = flags['api-key'];
  return cfg;
}

function dataDir(flags) {
  return flags.data ? path.resolve(flags.data) : path.join(ROOT, 'data');
}

/**
 * 凭据库口令 —— 与 bundle 口令是两回事。
 *   --password        bundle 解密口令（导入/导出用）
 *   --vault-password  凭据库口令（打开本机 accounts.vault 用）
 * 不指定 vault-password 时，凭据库用 data/local-key 文件保护。
 */
function openStore(flags, cfg) {
  return createStore({
    dataDir: dataDir(flags),
    kind: cfg.storage || 'json',
    password: flags['vault-password'] || process.env.TAV2_VAULT_PASSWORD || null,
  });
}

// ---------------------------------------------------------------- 输出

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function statusColor(s) {
  if (s === STATUS.ACTIVE) return C.green('可用');
  if (s === STATUS.NEEDS_RELOGIN) return C.yellow('需重登');
  if (s === STATUS.DISABLED) return C.dim('已禁用');
  return C.dim(s || '未知');
}

function printAccounts(records) {
  if (!records.length) { console.log(C.dim('  (没有账号)')); return; }
  console.log(C.dim('  ID                 账号名          tenant    状态      剩余有效期      绝对期限'));
  for (const r of records) {
    console.log(
      `  ${(r.id || '').padEnd(18)} ${(r.accountName || '-').padEnd(14)} ` +
      `${(r.tenant || '-').padEnd(8)} ${statusColor(r.status).padEnd(9)} ` +
      `${describe(r).padEnd(14)} ${describeAbsolute(r)}`
    );
    if (r.lastError) console.log(C.dim(`    └ ${r.lastError}`));
  }
}

// ---------------------------------------------------------------- 命令

const commands = {};

commands.scan = async (args, cfg) => {
  const store = openStore(args, cfg);
  console.log(C.bold('\n扫描本机 TeleAgent 账号'));
  console.log(C.dim(`数据目录: ${require(path.join(ROOT, 'lib', 'account-manager', 'scanner')).teleAgentDataDir()}\n`));

  const r = scanInto(store);
  if (r.added.length) {
    console.log(C.green(`✓ 新增 ${r.added.length} 个账号`));
    for (const a of r.added) console.log(`  + ${a.accountName || a.id}  ${C.dim(a.tenant || '')}`);
  }
  if (r.updated.length) {
    console.log(C.cyan(`↻ 更新 ${r.updated.length} 个账号`));
    for (const a of r.updated) console.log(`  ~ ${a.accountName || a.id}  ${C.dim(a.tenant || '')}`);
  }
  if (!r.added.length && !r.updated.length) {
    console.log(C.dim('  没有新账号（已存在且 token 未变）'));
  }
  for (const e of r.errors) {
    console.log(C.yellow(`! ${e.message}`));
    if (e.hint) console.log(C.dim(`  ${e.hint}`));
  }
  console.log('');
  printAccounts(store.list());
  console.log('');
};

commands.import = async (args, cfg) => {
  const file = args._[0];
  if (!file) throw new Error('用法: tav2 import <文件> [--password 口令]');
  const store = openStore(args, cfg);
  const r = importInto(store, path.resolve(file), {
    password: args.password || process.env.TAV2_BUNDLE_PASSWORD || null,
    format: args.format,
  });
  console.log(C.bold('\n导入账号'));
  console.log(C.green(`✓ 新增 ${r.added.length} 个，更新 ${r.updated.length} 个`));

  // 账号包里的渠道密钥 → 自动落地到 config，目标机零配置
  if (r.channelKey) {
    const ckPath = path.join(ROOT, 'config', 'channel-key.txt');
    try {
      fs.mkdirSync(path.join(ROOT, 'config'), { recursive: true });
      fs.writeFileSync(ckPath, r.channelKey, 'utf8');
      console.log(C.green('✓ 渠道密钥已自动配置'));
    } catch (e) {
      console.log(C.yellow(`! 渠道密钥写入失败：${e.message}`));
    }
  }

  for (const e of r.errors || []) console.log(C.yellow(`! ${e.message}`));
  console.log('');
  printAccounts(store.list());
  console.log('');
};

commands.export = async (args, cfg) => {
  const format = (args.format || 'bundle').toLowerCase();
  const out = args.out ? path.resolve(args.out) : path.join(ROOT, 'data', `账号包.${format === 'bundle' ? 'bundle' : format}`);
  const store = openStore(args, cfg);
  const records = store.list();
  if (!records.length) {
    console.log(C.yellow('没有可导出的账号。先运行 `tav2 scan` 扫描本机，或导入已有账号包。'));
    return;
  }
  // 渠道密钥一起打包 → 目标机零配置
  const ck = resolveChannelKey({ configDir: path.join(ROOT, 'config'), dataDir: dataDir(args) });
  const r = exportAccounts(records, {
    format,
    outPath: out,
    password: args.password || process.env.TAV2_BUNDLE_PASSWORD || null,
    channelKey: ck.key,
  });
  console.log(C.bold('\n导出账号'));
  console.log(C.green(`✓ ${r.count} 个账号 → ${out}`));
  if (format === 'bundle') {
    console.log(ck.key
      ? C.dim('  已包含渠道密钥，目标机无需再配置')
      : C.dim('  未找到渠道密钥，目标机需自行配置'));
    console.log(r.encrypted
      ? C.dim('  已用口令加密（导入时需提供相同口令）')
      : C.yellow('  ⚠ 未加密 —— 这个文件等同于账号密码，请妥善保管'));
  } else {
    console.log(C.dim('  仅含元信息，不含 token'));
  }
  console.log('');
};

commands.accounts = async (args, cfg) => {
  const store = openStore(args, cfg);
  const sub = args._[0];
  if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
    const id = args._[1];
    if (!id) throw new Error('用法: tav2 accounts rm <id>');
    store.remove(id);
    console.log(C.green(`✓ 已删除 ${id}`));
    return;
  }
  if (sub === 'enable' || sub === 'disable') {
    const id = args._[1];
    const r = store.get(id);
    if (!r) throw new Error(`账号不存在：${id}`);
    store.put({ ...r, status: sub === 'enable' ? STATUS.ACTIVE : STATUS.DISABLED });
    console.log(C.green(`✓ ${id} → ${sub === 'enable' ? '可用' : '已禁用'}`));
    return;
  }
  console.log(C.bold('\n账号列表'));
  const s = store.stats();
  console.log(C.dim(`  存储: ${s.kind}  ${s.path}`));
  console.log('');
  printAccounts(store.list());
  console.log('');
};

commands.refresh = async (args, cfg) => {
  const store = openStore(args, cfg);
  const pool = new AccountPool({ store });
  const refresher = new Refresher({
    store, pool,
    channelKey: 'n/a',
    intervalMs: (cfg.refresher?.intervalMinutes || 360) * 60000,
    aheadSeconds: (cfg.refresher?.aheadHours || 24) * 3600,
    appVersion: cfg.appVersion,
    log: (m) => console.log(C.dim(m)),
  });
  console.log(C.bold('\n立即续期'));
  const now = Math.floor(Date.now() / 1000);
  const targets = store.list().filter((r) => r.expiresAt && r.expiresAt - now < (cfg.refresher?.aheadHours || 24) * 3600);
  if (!targets.length) {
    console.log(C.dim('  没有即将到期的账号'));
    console.log('');
    return;
  }
  for (const r of targets) {
    const res = await refresher.refreshOne(r.id, '手动');
    if (res.ok) console.log(C.green(`  ✓ ${r.accountName || r.id}`));
    else console.log(C.yellow(`  ✗ ${r.accountName || r.id}  ${res.reason} ${res.code || ''}`));
  }
  console.log('');
};

commands.doctor = async (args, cfg) => {
  console.log(C.bold('\n环境自检'));
  console.log('');
  const ok = (m) => console.log(`  ${C.green('✓')} ${m}`);
  const warn = (m) => console.log(`  ${C.yellow('!')} ${m}`);
  const bad = (m) => console.log(`  ${C.red('✗')} ${m}`);

  console.log(`  Node 版本  : ${process.version}`);

  // 存储
  try {
    const store = openStore(args, cfg);
    const s = store.stats();
    ok(`存储可用    : ${s.kind}  ${s.path}`);
    console.log(C.dim(`              ${s.count} 个账号`));
  } catch (e) {
    bad(`存储不可用  : ${e.message}`);
  }

  // 渠道密钥
  const ck = resolveChannelKey({ configDir: path.join(ROOT, 'config'), dataDir: dataDir(args) });
  if (ck.key) ok(`渠道密钥    : ${ck.key.slice(0, 8)}…  ${C.dim(ck.source)}`);
  else bad('渠道密钥    : 未找到。装了 TeleAgent 会自动提取；否则把 channel-key 放到 config/channel-key.txt');

  // 账号
  try {
    const store = openStore(args, cfg);
    const list = store.list();
    if (!list.length) {
      warn('没有账号    : 运行 `tav2 scan` 扫描，或 `tav2 import <文件>` 导入');
    } else {
      const usable = list.filter((r) => evaluate(r).usable).length;
      if (usable) ok(`可用账号    : ${usable} / ${list.length}`);
      else warn(`可用账号    : 0 / ${list.length}（全部需要重新登录）`);
    }
  } catch (_) {}

  console.log('');
};

commands.test = async (args, cfg) => {
  const text = args._[0] || args.text || '用一句话说你是谁';
  const store = openStore(args, cfg);
  const pool = new AccountPool({ store });
  const ck = resolveChannelKey({ configDir: path.join(ROOT, 'config'), dataDir: dataDir(args) });
  if (!ck.key) throw new Error('找不到渠道密钥。先跑 `tav2 doctor` 看提示。');

  const refresher = new Refresher({
    store, pool, channelKey: ck.key,
    appVersion: cfg.appVersion,
    log: (m) => console.log(C.dim(m)),
  });

  console.log(C.bold('\n测试推理'));
  const { chatCompletion } = require(path.join(ROOT, 'lib', 'proxy', 'gateway'));
  const rec = pool.pick();
  if (!rec) throw new Error('没有可用账号。先 `tav2 scan` 或 `tav2 import`。');

  const fresh = await refresher.ensureFresh(rec);
  const r = await chatCompletion({
    token: fresh.token, channelKey: ck.key,
    deviceId: pool.deviceId, installId: pool.installId,
    appVersion: cfg.appVersion,
    body: { model: 'chat-flash', messages: [{ role: 'user', content: text }], stream: false },
  });
  if (r.status === 200 && r.json) {
    console.log(C.green('✓ ') + r.json.choices[0].message.content);
  } else {
    const e = require(path.join(ROOT, 'lib', 'proxy', 'api')).extractError(r.text, r.status);
    console.log(C.red(`✗ HTTP ${r.status}  ${e.code} ${e.message}`));
  }
  console.log('');
};

commands.serve = async (args, cfg) => {
  const store = openStore(args, cfg);
  const pool = new AccountPool({ store });
  const ck = resolveChannelKey({ configDir: path.join(ROOT, 'config'), dataDir: dataDir(args) });
  if (!ck.key) {
    throw new Error(
      '找不到渠道密钥。\n' +
      '  装了 TeleAgent  → 会自动从 app.asar 提取\n' +
      '  没装 TeleAgent  → 把 channel key 放到 config/channel-key.txt'
    );
  }
  const logger = createLogger({ logFile: path.join(dataDir(args), 'tav2.log') });
  const refresher = new Refresher({
    store, pool, channelKey: ck.key,
    intervalMs: (cfg.refresher?.intervalMinutes || 360) * 60000,
    aheadSeconds: (cfg.refresher?.aheadHours || 24) * 3600,
    appVersion: cfg.appVersion,
    log: logger.info,
  });
  const server = createServer({
    store, pool, refresher,
    channelKey: ck.key,
    apiKey: cfg.apiKey,
    appVersion: cfg.appVersion,
    log: logger.info,
  });

  const port = cfg.port || 8792;
  const host = cfg.host || '127.0.0.1';
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.log('');
      console.log(C.yellow(`✗ 端口 ${port} 已被占用`));
      console.log('');
      console.log('  可能是服务已经在跑了。检查一下：');
      console.log(`    curl http://${host}:${port}/health`);
      console.log('');
      console.log('  想换端口：加 --port 参数，例如 --port 8793');
      console.log('  想停掉旧的：schtasks /End /TN "TeleAgent Proxy V2"');
      console.log('');
      process.exit(1);
    }
    throw e;
  }

  refresher.start();
  const s = pool.summary();
  const baseUrl = `http://${host}:${port}/v1`;

  // 自动生成客户端配置并复制到剪贴板
  let cfgFile = null;
  try {
    const { writeConfigFile } = require(path.join(ROOT, 'lib', 'proxy', 'client-config'));
    cfgFile = writeConfigFile(ROOT, { baseUrl, apiKey: cfg.apiKey, model: 'chat-flagship' }).path;
  } catch (_) {}

  console.log('');
  console.log(C.green(`✓ 反代已启动`));
  console.log('');
  console.log(C.bold('  在你的 AI 客户端里填这三行：'));
  console.log('');
  console.log(`    Base URL : ${C.cyan(baseUrl)}`);
  console.log(`    API Key  : ${C.cyan(cfg.apiKey)}`);
  console.log(`    Model    : ${C.cyan('chat-flagship')}`);
  console.log('');
  console.log(C.dim(`  完整配置（Cherry Studio / Cline / Cursor 各自怎么填）：`));
  console.log(C.dim(`    ${cfgFile || '(生成失败)'}`));
  console.log('');
  console.log(C.dim(`  账号 ${s.usable}/${s.total} 可用`));
  console.log(C.dim(`  设备指纹 ${s.deviceId}`));
  console.log(C.dim(`  日志 ${path.join(dataDir(args), 'tav2.log')}`));
  console.log('');
  console.log(C.dim('  Ctrl+C 停止'));
  console.log('');

  const shutdown = () => {
    console.log('\n正在停止…');
    refresher.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

commands.help = async () => {
  console.log(`
${C.bold('tav2')} — TeleAgent 反代 v2

${C.bold('账号管理')}
  tav2 scan                      扫描本机 TeleAgent 账号并导入
  tav2 import <文件>             导入账号包（bundle / xlsx / json）
  tav2 export --out <文件>       导出账号（--format bundle|xlsx|csv）
  tav2 accounts                  查看账号列表
  tav2 accounts rm <id>          删除账号
  tav2 accounts disable|enable <id>

${C.bold('反代服务')}
  tav2 serve                     启动反代服务（默认 127.0.0.1:8792）
  tav2 refresh                   立即给快过期的账号续期
  tav2 test "你好"               发一条测试消息
  tav2 doctor                    环境自检

${C.bold('通用选项')}
  --port <端口>        监听端口（默认 8792）
  --host <地址>        监听地址（默认 127.0.0.1）
  --db json|sqlite     存储类型（默认 json；sqlite 需 Node 22+）
  --data <目录>        数据目录（默认 ./data）
  --password <口令>    bundle 解密口令（导入导出用）
  --vault-password <口令>  凭据库口令（保护本机 accounts.vault）
  --format <格式>      导入导出格式
  --out <文件>         输出路径
  --config <文件>      配置文件

${C.bold('典型流程')}
  ${C.cyan('本机：')}  tav2 scan && tav2 serve
  ${C.cyan('搬到别的机器：')}
    源机  tav2 export --out acc.bundle --password 你的口令
    目标机 tav2 import acc.bundle --password 你的口令 && tav2 serve
`);
};

commands.version = async () => {
  console.log('teleagent-proxy-v2 2.0.0');
};

// ---------------------------------------------------------------- 入口

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._.shift() || 'help';
  const cfg = loadConfig(args);

  const fn = commands[cmd];
  if (!fn) {
    console.error(`未知命令：${cmd}`);
    console.error('运行 `tav2 help` 看用法');
    process.exit(1);
  }
  await fn(args, cfg);
}

main().catch((e) => {
  console.error('');
  console.error(C.red('✗ ' + (e.message || String(e))));
  if (process.env.TAV2_DEBUG) console.error(e.stack);
  console.error('');
  process.exit(1);
});
