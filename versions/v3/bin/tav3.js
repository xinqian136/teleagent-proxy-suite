#!/usr/bin/env node
'use strict';
/**
 * tav3.js — TeleAgent 反代 v3 启动器
 *
 * 启动 Web 管理后台，所有功能都在网页上操作。
 *
 *   node bin/tav3.js            启动后台（默认）
 *   node bin/tav3.js --port 8795 换端口
 *   node bin/tav3.js --no-open   不自动开浏览器
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { Settings } = require(path.join(ROOT, 'lib', 'web', 'settings'));
const { createStore } = require(path.join(ROOT, 'lib', 'storage'));
const { ProxyManager } = require(path.join(ROOT, 'lib', 'web', 'manager'));
const { createWebServer } = require(path.join(ROOT, 'lib', 'web', 'server'));

// ---------------------------------------------------------------- 崩溃日志
const CRASH_LOG = path.join(ROOT, 'data', 'v3-crash.log');
function logCrash(kind, err) {
  try {
    fs.mkdirSync(path.dirname(CRASH_LOG), { recursive: true });
    fs.appendFileSync(CRASH_LOG,
      `[${new Date().toISOString()}] ${kind}: ${err && err.stack ? err.stack : err}\n\n`);
  } catch (_) {}
}
process.on('uncaughtException', (e) => {
  logCrash('uncaughtException', e);
  console.error(C.red('\n✗ 未捕获异常（已记入 data/v3-crash.log）：'));
  console.error(e && e.stack ? e.stack : e);
});
process.on('unhandledRejection', (e) => {
  logCrash('unhandledRejection', e);
  console.error(C.yellow('\n! 未处理的 Promise 拒绝：' + (e && e.message ? e.message : e)));
});

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) { flags[a.slice(2)] = next; i++; }
        else flags[a.slice(2)] = true;
      }
    } else positional.push(a);
  }
  return Object.assign({ _: positional }, flags);
}

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const settings = new Settings({ file: path.join(ROOT, 'config', 'settings.json') });

  // 命令行覆盖
  if (args.port) settings.set('web.port', Number(args.port));
  if (args['proxy-port']) settings.set('proxy.port', Number(args['proxy-port']));
  if (args['api-key']) settings.set('proxy.apiKey', String(args['api-key']));
  if (args['no-open']) settings.set('web.openBrowser', false);

  const store = createStore({
    dataDir: path.join(ROOT, 'data'),
    kind: settings.get('storage') || 'json',
    password: process.env.TAV3_VAULT_PASSWORD || null,
  });

  const logs = [];
  const log = (m) => {
    const line = typeof m === 'string' ? m : JSON.stringify(m);
    logs.push(line);
    if (logs.length > 300) logs.shift();
    console.log(C.dim(line));
  };

  const manager = new ProxyManager({
    store, settings, root: ROOT, log,
  });

  const { server } = createWebServer({
    settings, manager, store, root: ROOT, log,
    getStore: () => store,
  });

  const webPort = settings.get('web.port');
  const webHost = settings.get('web.host') || '127.0.0.1';

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(webPort, webHost, resolve);
  });

  const url = `http://${webHost}:${webPort}/`;
  console.log('');
  console.log(C.green('✓ TeleAgent 反代 v3 已启动'));
  console.log('');
  console.log(C.bold('  管理后台：') + C.cyan(url));
  console.log(C.dim(`  反代地址：${'http://' + (settings.get('proxy.host')) + ':' + (settings.get('proxy.port')) + '/v1'}`));
  console.log(C.dim(`  API Key ：${settings.get('proxy.apiKey')}`));
  console.log('');

  // 自动起反代（除非之前被暂停过）
  if (settings.get('proxy.paused')) {
    console.log(C.yellow('  ⏸ 反代处于暂停状态，未自动启动'));
    console.log(C.dim('    在网页「反代」页点「恢复」即可'));
  } else if (settings.get('proxy.autoStart')) {
    const r = await manager.start();
    if (r.ok) {
      console.log(C.green('  ✓ 反代已自动启动'));
    } else {
      console.log(C.yellow('  ! 反代启动失败：' + r.error));
      console.log(C.dim('    可在网页上「扫描本机」或「导入」后再点启动'));
    }
  }
  console.log('');
  console.log(C.dim('  浏览器打开这个地址就能用：'));
  console.log('');
  console.log('    ' + C.cyan(url));
  console.log('');
  console.log(C.dim('  Ctrl+C 停止'));
  console.log('');

  // 自动开浏览器
  if (settings.get('web.openBrowser') && !args['no-open']) {
    openBrowser(url);
  }

  const shutdown = () => {
    console.log('\n正在停止…');
    manager.stop().finally(() => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2500);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    exec(`${cmd} ${args.map((a) => `"${a}"`).join(' ')}`, { windowsHide: true });
  } catch (e) { /* 忽略 */ }
}

main().catch((e) => {
  console.error('');
  console.error(C.red('✗ ' + (e.message || String(e))));
  if (e.code === 'EADDRINUSE') {
    console.error(C.dim('  端口被占用。换个端口：node bin\\tav3.js --port 8796'));
  }
  console.error('');
  process.exit(1);
});
