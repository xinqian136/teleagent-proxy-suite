#!/usr/bin/env node
/**
 * ta-ctl.js — TeleAgent 反代统一管理入口
 *
 * 用法:
 *   node ta-ctl.js start   [a|b]     启动服务（a=8790 直连网关 / b=8788 走内核）
 *   node ta-ctl.js stop    [a|b|all] 停止服务
 *   node ta-ctl.js status            查看状态（端口、账号、模型可用性）
 *   node ta-ctl.js account           查看当前账号与凭据
 *   node ta-ctl.js models            列出可用模型
 *   node ta-ctl.js test  [text]      发一条测试消息
 *   node ta-ctl.js doctor            环境自检
 *   node ta-ctl.js workbuddy         打印 WorkBuddy 配置指引
 *
 * 环境变量:
 *   TA_PORT      端口（默认 a=8790 / b=8788）
 *   TA_API_KEY   API Key（默认 teleagent-local）
 *   TA_HOST      监听地址（默认 127.0.0.1）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, execSync } = require('child_process');
const HERE = __dirname;
const HOME = process.env.USERPROFILE || os.homedir();
const TA_DATA = path.join(HOME, '.local', 'share', 'TeleAgent');

const RUNTIMES = path.join(TA_DATA, 'runtimes');
// TA_NODE 可覆盖 node 路径。TeleAgent 启动时会杀掉其 runtimes/ 目录下的进程，
// 所以想活过 App 重启就要指定别的 node（如 WorkBuddy 自带的）。
const NODE = process.env.TA_NODE || path.join(RUNTIMES, 'node', 'node.exe');
const PYTHON = process.env.TA_PYTHON || path.join(RUNTIMES, 'python', 'python.exe');
const KERNEL_EXE = path.join(RUNTIMES, 'super-agent-code', 'bin', 'TeleAgent.exe');

const PROFILES = {
  a: {
    key: 'a',
    port: 8790,
    script: 'ta-shim-a.js',
    title: '方案A 直连云网关',
    desc: '原生支持自定义 tools；出站是「第二客户端」，封号风险较高',
  },
  b: {
    port: 8788,
    script: 'ta-shim.js',
    title: '方案B 走 TeleAgent 内核',
    desc: '出站由 App 进程发出，风险低；不支持自定义 tools',
  },
};
PROFILES.b.key = 'b';

const DEFAULT_API_KEY = 'teleagent-local';

// ---------------- 工具函数 ----------------

function netstatPort(port) {
  try {
    const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', shell: 'cmd.exe' });
    const lines = out.split(/\r?\n/).filter((l) => l.includes('LISTENING'));
    if (!lines.length) return null;
    const m = lines[0].match(/^\s*TCP\s+(\S+):(\d+)\s+(\S+)\s+LISTENING\s+(\d+)/);
    return m ? { addr: m[1], pid: m[4] } : null;
  } catch (_) {
    return null;
  }
}

function httpGet(port, path, headers = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers, timeout: 8000 }, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => resolve({ code: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ code: 0, body: '', err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ code: 0, body: '', err: 'timeout' }); });
  });
}

function httpPost(port, path, body, headers = {}) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
      timeout: 180000,
    }, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => resolve({ code: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ code: 0, body: '', err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ code: 0, body: '', err: 'timeout' }); });
    req.write(data); req.end();
  });
}

function getApiKey() {
  return process.env.TA_API_KEY || DEFAULT_API_KEY;
}

// ---------------- 子命令 ----------------

function cmdStart(which) {
  const p = PROFILES[which];
  if (!p) return console.error('未知方案：' + which + '（用 a 或 b）');

  const existing = netstatPort(p.port);
  if (existing) {
    console.log(`[✓] 方案${which.toUpperCase()} 已在运行  端口 ${p.port}  PID ${existing.pid}  (${existing.addr})`);
    return;
  }
  if (!fs.existsSync(NODE)) {
    console.error('[✗] 找不到 TeleAgent 自带 Node：' + NODE);
    console.error('    请先安装并启动一次 TeleAgent 桌面端。');
    return;
  }

  // 方案B 需要 sessionKey：没有就先提取（否则首次请求会卡在内存扫描上）
  if (p.key === 'b') ensureSessionKey();

  const env = {
    ...process.env,
    TA_PORT: String(p.port),
    TA_API_KEY: getApiKey(),
    TA_HOST: process.env.TA_HOST || '127.0.0.1',
  };

  // 优先用计划任务启动：进程脱离会话，WorkBuddy 关闭后仍在
  const started = startViaTask(p, env);
  if (started) {
    setTimeout(() => {
      const st = netstatPort(p.port);
      if (st) {
        console.log(`[✓] 方案${which.toUpperCase()} 已启动（计划任务）  端口 ${p.port}  PID ${st.pid}  监听 ${st.addr}`);
        console.log(`    ${p.title} — ${p.desc}`);
        console.log(`    Base URL : http://127.0.0.1:${p.port}/v1`);
        console.log(`    API Key  : ${getApiKey()}`);
        console.log('    [提示] 计划任务名 "TeleAgent Shim ' + which.toUpperCase() + '"，登录时自动启动。');
      } else {
        console.log(`[!] 计划任务已创建但端口未就绪，看日志：${path.join(HERE, 'shim-' + which + '.log')}`);
      }
    }, 3000);
    return;
  }

  // 回退：直接 spawn（可能被沙箱回收）
  const out = fs.openSync(path.join(HERE, 'shim-' + which + '.log'), 'a');
  const child = spawn(NODE, [path.join(HERE, p.script)], {
    env, detached: true, stdio: ['ignore', out, out], cwd: HERE,
  });
  child.unref();

  setTimeout(() => {
    const st = netstatPort(p.port);
    if (st) {
      console.log(`[✓] 方案${which.toUpperCase()} 已启动  端口 ${p.port}  PID ${st.pid}  监听 ${st.addr}`);
      console.log(`    ${p.title} — ${p.desc}`);
      console.log(`    Base URL : http://127.0.0.1:${p.port}/v1`);
      console.log(`    API Key  : ${getApiKey()}`);
      console.log('    [注意] 计划任务创建失败，当前进程可能在会话结束时被回收。');
      console.log('           → 在你自己的终端里跑同样的命令即可常驻；');
      console.log('           → 或用 `node ta-ctl.js autostart install` 装成计划任务。');
    } else {
      console.error(`[✗] 启动失败，看日志：${path.join(HERE, 'shim-' + which + '.log')}`);
    }
  }, 2500);
}

/**
 * 确保 session.key 存在（方案B 需要）。
 * 没有就跑 find-sessionkey.py 扫内存提取 —— 慢但只做一次。
 */
function ensureSessionKey() {
  const keyFile = path.join(HERE, 'session.key');
  if (fs.existsSync(keyFile) && fs.readFileSync(keyFile, 'utf8').trim().length >= 40) {
    return true;
  }
  if (!netstatPort(4397)) {
    console.log('    [提示] 内核 4397 未监听，无法提取 sessionKey（方案B 需要 TeleAgent App 开着且已登录）');
    return false;
  }
  console.log('    正在提取 sessionKey（扫内存，约需 1–3 分钟，请稍候）…');
  try {
    execSync(`"${PYTHON}" "${path.join(HERE, 'find-sessionkey.py')}"`, {
      stdio: 'inherit', shell: 'cmd.exe', timeout: 600000,
    });
  } catch (e) {
    console.error('    [✗] sessionKey 提取失败：' + ((e.message || '').split('\n')[0]));
    return false;
  }
  return fs.existsSync(keyFile);
}

/**
 * 用 Windows 计划任务启动 —— 进程独立于调用者会话，WorkBuddy 退出后仍在。
 * 通过 launch.cmd 包装脚本传参，避开 schtasks 的引号嵌套问题。
 * 需要权限创建任务；失败返回 false 让调用方回退。
 */
function startViaTask(p, env) {
  const taskName = taskNameFor(p.key);
  const launcher = path.join(HERE, 'launch.cmd');
  if (!fs.existsSync(launcher)) return false;

  // TR 里只保留一层引号：launch.cmd 及其参数
  const tr = `"${launcher}" ${p.port} ${env.TA_API_KEY} ${env.TA_HOST} ${p.key} "${NODE}"`;

  try {
    try { execSync(`schtasks /Delete /TN "${taskName}" /F`, { stdio: 'ignore', shell: 'cmd.exe' }); } catch (_) {}
    execSync(
      `schtasks /Create /TN "${taskName}" /TR "${tr}" /SC ONLOGON /RL LIMITED /F`,
      { stdio: 'pipe', shell: 'cmd.exe' }
    );
    execSync(`schtasks /Run /TN "${taskName}"`, { stdio: 'pipe', shell: 'cmd.exe' });
    return true;
  } catch (e) {
    const msg = ((e.stderr || Buffer.alloc(0)).toString() || e.message || '').split('\n')[0];
    console.error('    [计划任务失败] ' + msg.trim());
    return false;
  }
}

function cmdStop(which) {
  const list = which === 'all' ? ['a', 'b'] : [which];
  for (const w of list) {
    const p = PROFILES[w];
    if (!p) continue;
    const st = netstatPort(p.port);
    if (!st) { console.log(`[·] 方案${w.toUpperCase()} 未运行`); continue; }
    try {
      execSync(`taskkill /PID ${st.pid} /F`, { stdio: 'ignore', shell: 'cmd.exe' });
      console.log(`[✓] 方案${w.toUpperCase()} 已停止 (PID ${st.pid})`);
    } catch (e) {
      console.error(`[✗] 停止失败 PID ${st.pid}: ${e.message}`);
    }
  }
}

async function cmdStatus() {
  console.log('=== 服务状态 ===');
  for (const w of ['a', 'b']) {
    const p = PROFILES[w];
    const st = netstatPort(p.port);
    if (!st) { console.log(`  方案${w.toUpperCase()} (${p.port}) : 未运行`); continue; }
    const h = await httpGet(p.port, '/health');
    let info = '';
    try { const j = JSON.parse(h.body); info = JSON.stringify(j).slice(0, 150); } catch (_) { info = h.body.slice(0, 120) || h.err || ''; }
    console.log(`  方案${w.toUpperCase()} (${p.port}) : 运行中  PID ${st.pid}  ${st.addr}`);
    console.log(`      ${info}`);
  }

  console.log('\n=== 账号 / 凭据 ===');
  try {
    const { getToken, getDeviceMeta } = require('./ta-token');
    const t = getToken();
    const dm = getDeviceMeta();
    const jwt = (t.token.split(':')[1] || '').split('.');
    let exp = '未知';
    try {
      const pl = JSON.parse(Buffer.from(jwt[1], 'base64url').toString('utf8'));
      if (pl.exp) exp = new Date(pl.exp * 1000).toLocaleString('zh-CN');
    } catch (_) {}
    console.log('  账号目录 :', t.account);
    console.log('  tenant   :', t.token.split(':')[0]);
    console.log('  JWT 过期 :', exp);
    console.log('  deviceId :', dm.deviceId || '(无)');
    console.log('  installId:', dm.installId || '(无)');
  } catch (e) {
    console.log('  [读取失败]', e.message);
  }

  console.log('\n=== TeleAgent App ===');
  const procs = netstatPort(4397);
  console.log('  内核 4397 :', procs ? `运行中 (PID ${procs.pid})` : '未运行（方案B 需要它）');
}

async function cmdAccount() {
  const { getToken, getDeviceMeta } = require('./ta-token');
  const t = getToken();
  const dm = getDeviceMeta();
  console.log('当前账号目录 :', t.account);
  console.log('tenant       :', t.token.split(':')[0]);
  const jwt = (t.token.split(':')[1] || '').split('.');
  try {
    const pl = JSON.parse(Buffer.from(jwt[1], 'base64url').toString('utf8'));
    console.log('JWT payload  :', JSON.stringify(pl));
  } catch (_) {}
  console.log('deviceId     :', dm.deviceId || '(无)');
  console.log('installId    :', dm.installId || '(无)');
  console.log('\n账号切换说明：在 TeleAgent App 里退出并登录新账号即可，');
  console.log('shim 每次请求都会重新读取最新 token.json，无需重启。');
}

async function cmdModels() {
  const port = Number(process.env.TA_PORT || 8790);
  const r = await httpGet(port, '/v1/models', { Authorization: 'Bearer ' + getApiKey() });
  if (r.code !== 200) {
    console.log('[✗] 取模型列表失败 HTTP', r.code, r.err || r.body.slice(0, 120));
    return;
  }
  const j = JSON.parse(r.body);
  console.log('端口 ' + port + ' 可用模型：');
  for (const m of j.data) console.log('  ', m.id);
}

async function cmdTest(text) {
  const port = Number(process.env.TA_PORT || 8790);
  const msg = text || '用一句话介绍你自己';
  const r = await httpPost(port, '/v1/chat/completions',
    { model: 'chat-flagship', messages: [{ role: 'user', content: msg }] },
    { Authorization: 'Bearer ' + getApiKey() });
  if (r.code !== 200) {
    console.log('[✗] HTTP', r.code, r.body.slice(0, 300));
    return;
  }
  try {
    const j = JSON.parse(r.body);
    console.log('[✓]', j.choices[0].message.content);
  } catch (_) {
    console.log('[?]', r.body.slice(0, 300));
  }
}

function cmdDoctor() {
  const items = [];
  const chk = (name, ok, detail) => items.push({ name, ok, detail });

  chk('TeleAgent 自带 Node', fs.existsSync(NODE), NODE);
  chk('TeleAgent 自带 Python', fs.existsSync(PYTHON), PYTHON);
  chk('Go 内核可执行文件', fs.existsSync(KERNEL_EXE), KERNEL_EXE);
  chk('AES key (token.key)', fs.existsSync(path.join(HERE, 'token.key')),
    fs.existsSync(path.join(HERE, 'token.key')) ? '已就绪' : '缺失 → 需跑 setup 解密');
  chk('TeleAgent Local State', fs.existsSync(path.join(TA_DATA, 'Local State')), 'DPAPI 密钥来源');
  chk('内核 4397 在监听', !!netstatPort(4397), netstatPort(4397) ? '方案B 可用' : '方案B 不可用');
  chk('方案A 8790', !!netstatPort(8790), netstatPort(8790) ? '运行中' : '未启动');
  chk('方案B 8788', !!netstatPort(8788), netstatPort(8788) ? '运行中' : '未启动');

  console.log('=== 环境自检 ===');
  for (const i of items) {
    console.log('  [' + (i.ok ? '✓' : '✗') + '] ' + i.name.padEnd(24) + i.detail);
  }
  const bad = items.filter((i) => !i.ok);
  console.log('\n' + (bad.length ? bad.length + ' 项待处理' : '全部就绪'));
}

function cmdWorkbuddy() {
  const port = process.env.TA_PORT || 8790;
  console.log('=== WorkBuddy 配置（设置 → 模型 → 添加模型）===');
  console.log('  供应商        : 自定义');
  console.log('  模型名称      : chat-flagship');
  console.log('  接口地址      : http://127.0.0.1:' + port + '/v1/chat/completions');
  console.log('  API Key       : ' + getApiKey());
  console.log('  工具调用      : 勾选');
  console.log('  图片输入      : 不勾（网关不支持 vision）');
  console.log('  思考模式      : 勾选');
  console.log('  允许关闭思考  : 不勾');
  console.log('  自定义协议    : 勾选');
  console.log('  最大输入 Token: 1000000');
  console.log('  最大输出 Token: 65536');
  console.log('\n  可用模型 id: chat-flagship / chat-pro / chat-flash / chat-lite / chat-nano');
  console.log('  注意: chat-pro 偶发 50301 负载已满，属网关侧临时拥塞。');
}

// ---------------- 开机自启（计划任务） ----------------

function taskNameFor(w) {
  return 'TeleAgent Shim ' + w.toUpperCase();
}

function cmdAutostart(sub, which) {
  const list = which ? [which] : ['a', 'b'];
  const launcher = path.join(HERE, 'launch.cmd');
  for (const w of list) {
    const p = PROFILES[w];
    const name = taskNameFor(w);
    if (sub === 'uninstall') {
      try {
        execSync(`schtasks /Delete /TN "${name}" /F`, { stdio: 'ignore', shell: 'cmd.exe' });
        console.log(`[✓] 已删除计划任务：${name}`);
      } catch (e) {
        console.log(`[·] 计划任务不存在或删除失败：${name}`);
      }
      continue;
    }

    if (!fs.existsSync(launcher)) {
      console.error(`[✗] 缺少启动包装脚本：${launcher}`);
      continue;
    }
    const tr = `"${launcher}" ${p.port} ${getApiKey()} ${process.env.TA_HOST || '127.0.0.1'} ${w} "${NODE}"`;
    try {
      try { execSync(`schtasks /Delete /TN "${name}" /F`, { stdio: 'ignore', shell: 'cmd.exe' }); } catch (_) {}
      execSync(
        `schtasks /Create /TN "${name}" /TR "${tr}" /SC ONLOGON /RL LIMITED /F`,
        { stdio: 'pipe', shell: 'cmd.exe' }
      );
      console.log(`[✓] 计划任务已创建：${name}  (登录时自动启动方案${w.toUpperCase()}，端口 ${p.port})`);
    } catch (e) {
      const msg = ((e.stderr || Buffer.alloc(0)).toString() || e.message || '').split('\n')[0];
      console.error(`[✗] 创建失败：${name}`);
      console.error('    ' + msg.trim());
      console.error('    可能需要管理员权限；也可手动运行：schtasks /Create ...');
    }
  }
}

// ---------------- 入口 ----------------

const CMD = process.argv[2] || 'status';
const ARG = process.argv[3];

switch (CMD) {
  case 'start': cmdStart(ARG || 'a'); break;
  case 'stop': cmdStop(ARG || 'all'); break;
  case 'status': cmdStatus().catch((e) => console.error(e.message)); break;
  case 'account': cmdAccount().catch((e) => console.error(e.message)); break;
  case 'models': cmdModels().catch((e) => console.error(e.message)); break;
  case 'test': cmdTest(ARG).catch((e) => console.error(e.message)); break;
  case 'doctor': cmdDoctor(); break;
  case 'workbuddy': cmdWorkbuddy(); break;
  case 'autostart':
    if (ARG === 'install') cmdAutostart('install', process.argv[4]);
    else if (ARG === 'uninstall') cmdAutostart('uninstall', process.argv[4]);
    else console.log('用法: node ta-ctl.js autostart install|uninstall [a|b]');
    break;
  default:
    console.log(`ta-ctl.js — TeleAgent 反代管理

  node ta-ctl.js start [a|b]      启动（a=8790 直连网关 / b=8788 走内核）
  node ta-ctl.js stop [a|b|all]   停止
  node ta-ctl.js status           状态总览
  node ta-ctl.js account          当前账号与凭据
  node ta-ctl.js models           可用模型
  node ta-ctl.js test [text]      发测试消息
  node ta-ctl.js doctor           环境自检
  node ta-ctl.js workbuddy        WorkBuddy 配置指引
  node ta-ctl.js autostart install|uninstall [a|b]   开机自启（计划任务）`);
}
