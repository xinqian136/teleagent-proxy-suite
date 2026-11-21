/* TeleAgent 反代 v3 · 管理后台前端
 * 零依赖、零构建。原生 JS。
 */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let STATE = { overview: null, accounts: [], settings: null };

// ---------------------------------------------------------------- 工具

async function api(path, opts = {}) {
  const r = await fetch('/api/admin/' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error((j && j.error && j.error.message) || ('HTTP ' + r.status));
  return j;
}

function toast(msg, kind) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.hidden = false;
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.hidden = true; }, 3200);
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDur(ms) {
  if (!ms || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return d + ' 天 ' + h + ' 小时';
  if (h) return h + ' 小时 ' + m + ' 分';
  return m + ' 分';
}

function statusTag(s) {
  if (s === 'active') return '<span class="tag ok">可用</span>';
  if (s === 'needsRelogin') return '<span class="tag warn">需重登</span>';
  if (s === 'disabled') return '<span class="tag off">已禁用</span>';
  return '<span class="tag off">' + (s || '未知') + '</span>';
}

// ---------------------------------------------------------------- 页面切换

$$('.nav-item').forEach((b) => {
  b.onclick = () => {
    $$('.nav-item').forEach((x) => x.classList.remove('active'));
    $$('.page').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $('#page-' + b.dataset.page).classList.add('active');
    refresh(b.dataset.page);
  };
});

// ---------------------------------------------------------------- 概览

async function refreshOverview() {
  const d = await api('overview');
  STATE.overview = d;

  const px = d.proxy || {};
  const pxRunning = px.state === 'running';
  const paused = !!d.settings?.proxy?.paused;
  const acc = d.accounts || {};

  $('#ovCards').innerHTML = `
    <div class="metric ${pxRunning ? 'ok' : paused ? 'warn' : 'err'}">
      <div class="lab">反代服务</div>
      <div class="val" style="font-size:19px">${pxRunning ? '运行中' : paused ? '已暂停' : '已停止'}</div>
      <div class="sub">${pxRunning ? `${px.host}:${px.port}` : paused ? '重启后台也不会自动启动' : '未启动'}</div>
    </div>
    <div class="metric ${acc.usable ? 'ok' : 'warn'}">
      <div class="lab">可用账号</div>
      <div class="val">${acc.usable}</div>
      <div class="sub">共 ${acc.total} 个${acc.needsRelogin ? ` · ${acc.needsRelogin} 个需重登` : ''}</div>
    </div>
    <div class="metric">
      <div class="lab">运行时长</div>
      <div class="val" style="font-size:19px">${pxRunning ? fmtDur(px.uptimeMs) : '-'}</div>
      <div class="sub">后台 ${fmtDur(d.uptime * 1000)}</div>
    </div>
    <div class="metric">
      <div class="lab">存储</div>
      <div class="val" style="font-size:19px">${d.storage.kind === 'sqlite' ? 'SQLite' : 'JSON'}</div>
      <div class="sub">${d.node} · ${d.platform}</div>
    </div>`;

  const base = `http://${px.host || '127.0.0.1'}:${px.port}/v1`;
  $('#ovConfig').textContent =
    `Base URL : ${base}\nAPI Key  : ${px.apiKey || '-'}\nModel    : chat-flagship`;

  $('#ovHint').textContent = pxRunning
    ? `反代在跑。任何 OpenAI 兼容客户端填上面三行就能用。`
    : (px.error ? '启动失败：' + px.error : '反代没启动。点「启动反代」。');

  $('#sideStatus').innerHTML = `<b>反代</b> ${pxRunning ? '运行中' : '已停止'} · ${px.port}<br><b>账号</b> ${acc.usable}/${acc.total} 可用`;
  $('#brandSub').textContent = pxRunning ? '运行中 · :' + px.port : '已停止';
}

// ---------------------------------------------------------------- 账号

async function refreshAccounts() {
  const d = await api('accounts');
  STATE.accounts = d.accounts || [];
  const body = $('#accBody');
  const empty = $('#accEmpty');

  if (!STATE.accounts.length) {
    body.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  body.innerHTML = STATE.accounts.map((a) => {
    const cls = a.status === 'active' ? 'ok' : a.status === 'needsRelogin' ? 'warn' : 'off';
    const near = a.expiresAt && (a.expiresAt - Date.now() / 1000) < 24 * 3600;
    return `<tr data-id="${a.id}">
      <td>
        <div style="font-weight:500">${esc(a.accountName || '(未命名)')}</div>
        <div class="dim mono" style="font-size:11px">${esc(a.tokenPreview)}</div>
        ${a.lastError ? `<div class="err-line">${esc(a.lastError)}</div>` : ''}
      </td>
      <td class="mono dim">${esc(a.tenant || '-')}</td>
      <td>${statusTag(a.status)}</td>
      <td class="${near ? 'err-line' : ''}">${esc(a.expiresIn)}</td>
      <td class="dim">${esc(a.absoluteExpiresIn)}</td>
      <td class="dim" style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.note || '-')}</td>
      <td class="ta-r" style="white-space:nowrap">
        <button class="link" data-act="edit">编辑</button>
        <button class="link" data-act="toggle">${a.status === 'disabled' ? '启用' : '禁用'}</button>
        <button class="link del" data-act="del">删除</button>
      </td>
    </tr>`;
  }).join('');

  body.querySelectorAll('tr[data-id]').forEach((tr) => {
    const id = tr.dataset.id;
    const acc = STATE.accounts.find((x) => x.id === id);
    tr.querySelector('[data-act=edit]').onclick = () => openEdit(acc);
    tr.querySelector('[data-act=toggle]').onclick = async () => {
      const ns = acc.status === 'disabled' ? 'active' : 'disabled';
      await api('account', { method: 'PUT', body: { id, status: ns } });
      toast(ns === 'active' ? '已启用' : '已禁用', 'ok');
      refreshAccounts();
      refreshOverview();
    };
    tr.querySelector('[data-act=del]').onclick = async () => {
      if (!confirm(`确定删除账号 ${acc.accountName || id}？`)) return;
      await api('account', { method: 'DELETE', body: { id } });
      toast('已删除', 'ok');
      refreshAccounts();
      refreshOverview();
    };
  });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function openEdit(acc) {
  openModal('编辑账号', `
    <label class="fld"><span>账号名</span><input class="inp" id="edName" value="${esc(acc.accountName || '')}" disabled></label>
    <label class="fld"><span>备注</span><input class="inp" id="edNote" value="${esc(acc.note || '')}" placeholder="随便写点什么"></label>
    <label class="fld"><span>状态</span>
      <select class="inp" id="edStatus">
        <option value="active"${acc.status === 'active' ? ' selected' : ''}>可用</option>
        <option value="needsRelogin"${acc.status === 'needsRelogin' ? ' selected' : ''}>需重登</option>
        <option value="disabled"${acc.status === 'disabled' ? ' selected' : ''}>已禁用</option>
      </select>
    </label>
    <label class="fld"><span>手动替换 token（可选）</span>
      <input class="inp" id="edToken" placeholder="tenant:eyJ..." >
    </label>
    <p class="hint">手动填 token 一般不用；账号需重登时，在 TeleAgent 里登录后重新「扫描本机」更省事。</p>
  `, [
    { text: '取消', cls: 'ghost' },
    {
      text: '保存', primary: true, fn: async () => {
        const body = {
          id: acc.id,
          note: $('#edNote').value,
          status: $('#edStatus').value,
        };
        const tk = $('#edToken').value.trim();
        if (tk) body.token = tk;
        await api('account', { method: 'PUT', body });
        toast('已保存', 'ok');
        refreshAccounts();
        refreshOverview();
      }
    },
  ]);
}

// ---------------------------------------------------------------- 导入 / 导出

function openImport() {
  openModal('导入账号', `
    <p class="hint" style="margin-top:0">选一个 <code>.bundle</code> 账号包上传，或填写服务器上的文件路径。</p>
    <label class="fld"><span>上传文件</span><input class="inp" type="file" id="imFile" accept=".bundle,.json"></label>
    <label class="fld"><span>或：服务器上的路径</span><input class="inp" id="imPath" placeholder="D:\\账号包.bundle"></label>
    <label class="fld"><span>口令（如果包加密了）</span><input class="inp" id="imPwd" type="password" placeholder="留空表示未加密"></label>
  `, [
    { text: '取消', cls: 'ghost' },
    {
      text: '导入', primary: true, fn: async () => {
        const pwd = $('#imPwd').value;
        const fileEl = $('#imFile');
        if (fileEl.files && fileEl.files[0]) {
          const content = await fileEl.files[0].text();
          const r = await api('import', { method: 'POST', body: { content, password: pwd || null } });
          toast(`导入完成：新增 ${r.added}，更新 ${r.updated}`, 'ok');
        } else {
          const p = $('#imPath').value.trim();
          if (!p) { toast('请选文件或填路径', 'err'); return false; }
          const r = await api('import', { method: 'POST', body: { path: p, password: pwd || null } });
          toast(`导入完成：新增 ${r.added}，更新 ${r.updated}`, 'ok');
        }
        refreshAccounts();
        refreshOverview();
      }
    },
  ]);
}

function openExport() {
  openModal('导出账号', `
    <label class="fld"><span>格式</span>
      <select class="inp" id="exFmt">
        <option value="bundle">账号包（.bundle，可跨机器，含 token）</option>
        <option value="xlsx">Excel（.xlsx，仅元信息，方便查看）</option>
        <option value="csv">CSV（仅元信息）</option>
      </select>
    </label>
    <label class="fld"><span>口令（可选，加密账号包）</span><input class="inp" id="exPwd" type="password" placeholder="留空则不加密"></label>
    <p class="hint">账号包等同于账号密码，请勿外传。</p>
  `, [
    { text: '取消', cls: 'ghost' },
    {
      text: '导出', primary: true, fn: async () => {
        const fmt = $('#exFmt').value;
        const pwd = $('#exPwd').value;
        const r = await api('export', { method: 'POST', body: { format: fmt, password: pwd || null } });
        if (fmt === 'bundle') {
          // 触发下载
          const blob = new Blob([r.content], { type: 'application/octet-stream' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = r.filename;
          a.click();
          URL.revokeObjectURL(a.href);
          toast(`已导出 ${r.count} 个账号（${r.encrypted ? '已加密' : '未加密'}）`, 'ok');
        } else if (fmt === 'xlsx') {
          window.open(r.downloadUrl, '_blank');
          toast(`已导出 ${r.count} 个账号`, 'ok');
        } else {
          const blob = new Blob([r.content], { type: 'text/csv;charset=utf-8' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'accounts.csv';
          a.click();
          URL.revokeObjectURL(a.href);
          toast(`已导出 ${r.count} 个账号`, 'ok');
        }
      }
    },
  ]);
}

// ---------------------------------------------------------------- 反代

async function refreshProxy() {
  const d = await api('proxy');
  const px = d.proxy;
  const paused = !!d.paused;
  const running = px.state === 'running';

  $('#pxCards').innerHTML = `
    <div class="metric ${running ? 'ok' : paused ? 'warn' : 'err'}">
      <div class="lab">状态</div>
      <div class="val" style="font-size:19px">${running ? '运行中' : paused ? '已暂停' : '已停止'}</div>
      <div class="sub">${px.error ? esc(px.error) : (running ? '正常' : paused ? '重启后台后也不会自动启动' : '未启动')}</div>
    </div>
    <div class="metric">
      <div class="lab">监听</div>
      <div class="val" style="font-size:19px">${px.host}:${px.port}</div>
      <div class="sub">${running ? '已占用' : '空闲'}</div>
    </div>
    <div class="metric ${px.channelKeyFound ? 'ok' : 'err'}">
      <div class="lab">渠道密钥</div>
      <div class="val" style="font-size:19px">${px.channelKeyFound ? '已就绪' : '缺失'}</div>
      <div class="sub">${px.channelKeyFound ? '可用于推理' : '请扫描或导入'}</div>
    </div>
    <div class="metric">
      <div class="lab">账号池</div>
      <div class="val">${px.accounts ? px.accounts.usable : 0}/${px.accounts ? px.accounts.total : 0}</div>
      <div class="sub">可用 / 总数</div>
    </div>`;

  const base = `http://${px.host || '127.0.0.1'}:${px.port}`;
  $('#epOpenai').textContent = base + '/v1/chat/completions';
  $('#epAnthropic').textContent = base + '/v1/messages';
  $('#epHealth').textContent = base + '/health';
  $('#epModels').textContent = base + '/v1/models';

  $('#btnStartProxy').disabled = running;
  $('#btnStopProxy').disabled = !running;
  $('#btnPauseProxy').disabled = !running;
  $('#btnResumeProxy').disabled = running;
}

// ---------------------------------------------------------------- 设置

async function refreshSettings() {
  const d = await api('settings');
  const s = d.settings;
  STATE.settings = s;
  $('#setPort').value = s.proxy.port;
  $('#setHost').value = s.proxy.host;
  $('#setKey').value = s.proxy.apiKey;
  $('#setAuto').checked = !!s.proxy.autoStart;
  $('#setStore').value = s.storage;
  $('#setInterval').value = s.refresher.intervalMinutes;
  $('#setAhead').value = s.refresher.aheadHours;
}

async function saveSettings() {
  const body = {
    'proxy.port': Number($('#setPort').value),
    'proxy.host': $('#setHost').value.trim(),
    'proxy.apiKey': $('#setKey').value.trim(),
    'proxy.autoStart': $('#setAuto').checked,
    'storage': $('#setStore').value,
    'refresher.intervalMinutes': Number($('#setInterval').value),
    'refresher.aheadHours': Number($('#setAhead').value),
  };
  try {
    const r = await api('settings', { method: 'PUT', body });
    $('#setHint').textContent = r.proxyRestarted
      ? '已保存，反代已重启使配置生效。' + (r.proxyError ? '（重启失败：' + r.proxyError + '）' : '')
      : '已保存。';
    toast('设置已保存', 'ok');
    refreshSettings();
    refreshOverview();
    refreshProxy();
  } catch (e) {
    $('#setHint').textContent = '保存失败：' + e.message;
    toast(e.message, 'err');
  }
}

// ---------------------------------------------------------------- 日志

async function refreshLogs() {
  const wantRequests = $('#logTab').checked;
  if (wantRequests) {
    const d = await api('requests?n=200');
    const rs = d.requests || [];
    $('#logOut').textContent = rs.length
      ? rs.map((r) => {
          const t = new Date(r.t).toLocaleTimeString('zh-CN', { hour12: false });
          return `[${t}] ${r.path}  ${r.summary}`;
        }).join('\n')
      : '（暂无请求记录）';
    const el = $('#logOut');
    el.scrollTop = el.scrollHeight;
    return;
  }
  const d = await api('logs?n=300');
  const logs = d.logs || [];
  $('#logOut').textContent = logs.length
    ? logs.map((l) => `[${fmtTime(l.t / 1000).slice(11)}] ${l.line}`).join('\n')
    : '（暂无日志）';
  const el = $('#logOut');
  el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------- 弹窗

function openModal(title, bodyHtml, buttons) {
  $('#mTitle').textContent = title;
  $('#mBody').innerHTML = bodyHtml;
  const foot = $('#mFoot');
  foot.innerHTML = '';
  (buttons || []).forEach((b) => {
    const btn = document.createElement('button');
    btn.className = 'btn' + (b.cls ? ' ' + b.cls : '');
    btn.textContent = b.text;
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const r = b.fn ? await b.fn() : true;
        if (r !== false) closeModal();
      } catch (e) {
        toast(e.message, 'err');
      } finally {
        btn.disabled = false;
      }
    };
    foot.appendChild(btn);
  });
  $('#modal').hidden = false;
}

function closeModal() { $('#modal').hidden = true; }
$('#mClose').onclick = closeModal;
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ---------------------------------------------------------------- 事件绑定

$('#btnScan').onclick = $('#btnScan2').onclick = async () => {
  try {
    const r = await api('scan', { method: 'POST' });
    toast(`扫描完成：新增 ${r.added}，更新 ${r.updated}`, 'ok');
    if (r.errors && r.errors.length) {
      openModal('扫描提示', r.errors.map((e) => `<p class="hint">${esc(e.message)}<br>${esc(e.hint || '')}</p>`).join(''), [{ text: '知道了', primary: true }]);
    }
    refreshAccounts(); refreshOverview(); refreshProxy();
  } catch (e) { toast(e.message, 'err'); }
};

$('#btnImport').onclick = openImport;
$('#btnExport').onclick = openExport;

$('#btnStartProxy').onclick = async () => {
  try { await api('proxy/start', { method: 'POST' }); toast('反代已启动', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
  refreshOverview(); refreshProxy();
};
$('#btnStopProxy').onclick = async () => {
  try { await api('proxy/stop', { method: 'POST' }); toast('反代已停止', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
  refreshOverview(); refreshProxy();
};

// 暂停 = 停止 + 持久化（重启后台后也不会自动起）
$('#btnPauseProxy').onclick = async () => {
  if (!confirm('暂停反代？\n\n暂停后即使重启后台，反代也不会自动启动，需要在网页上手动点「恢复」。')) return;
  try {
    await api('proxy/pause', { method: 'POST' });
    toast('已暂停（重启后台后也不会自动启动）', 'ok');
  } catch (e) { toast(e.message, 'err'); }
  refreshOverview(); refreshProxy();
};

$('#btnResumeProxy').onclick = async () => {
  try { await api('proxy/resume', { method: 'POST' }); toast('已恢复', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
  refreshOverview(); refreshProxy();
};

$('#btnTest').onclick = async () => {
  const out = $('#testOut');
  out.textContent = '发送中…';
  try {
    const r = await api('test', { method: 'POST', body: { message: $('#testMsg').value, model: $('#testModel').value } });
    out.textContent = r.content + (r.usage ? '\n\n---\n' + JSON.stringify(r.usage) : '');
  } catch (e) {
    out.textContent = '失败：' + e.message;
  }
};

$('#btnSave').onclick = saveSettings;
$('#btnReset').onclick = async () => {
  if (!confirm('恢复默认设置？端口和 API Key 会变回默认值。')) return;
  await api('settings/reset', { method: 'POST' });
  toast('已恢复默认', 'ok');
  refreshSettings(); refreshOverview(); refreshProxy();
};

$('#btnRefreshLog').onclick = refreshLogs;
$('#logTab').onchange = refreshLogs;

$('#btnCopyCfg').onclick = async () => {
  const px = (STATE.overview && STATE.overview.proxy) || {};
  const base = `http://${px.host || '127.0.0.1'}:${px.port}/v1`;
  const text = `Base URL : ${base}\nAPI Key  : ${px.apiKey || '-'}\nModel    : chat-flagship`;
  try {
    await navigator.clipboard.writeText(text);
    toast('配置已复制', 'ok');
  } catch (e) {
    openModal('客户端配置', `<div class="cfgbox">${esc(text)}</div>`, [{ text: '关闭', primary: true }]);
  }
};

$('#btnClientCfg').onclick = async () => {
  try {
    const d = await api('client-config');
    const html = Object.entries(d.configs).map(([k, v]) =>
      `<div style="margin-bottom:14px"><div style="font-weight:500;margin-bottom:5px">${esc(k)}</div><div class="cfgbox">${esc(v)}</div></div>`).join('');
    openModal('各客户端怎么填', html, [{ text: '关闭', primary: true }]);
  } catch (e) { toast(e.message, 'err'); }
};

// ---------------------------------------------------------------- 轮询

let timer = null;
function refresh(page) {
  if (page === 'overview') refreshOverview().catch(() => {});
  else if (page === 'accounts') refreshAccounts().catch(() => {});
  else if (page === 'proxy') refreshProxy().catch(() => {});
  else if (page === 'settings') refreshSettings().catch(() => {});
  else if (page === 'logs') refreshLogs().catch(() => {});
}

function startPolling() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    const page = $('.nav-item.active').dataset.page;
    if (page === 'overview') refreshOverview().catch(() => {});
    else if (page === 'accounts') refreshAccounts().catch(() => {});
    else if (page === 'proxy') refreshProxy().catch(() => {});
    else if (page === 'logs' && $('#autoLog').checked) refreshLogs().catch(() => {});
  }, 4000);
}

$('#autoLog').onchange = startPolling;

refreshOverview().catch((e) => toast('连接后台失败：' + e.message, 'err'));
startPolling();
