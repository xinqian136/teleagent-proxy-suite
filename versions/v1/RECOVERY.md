# TeleAgent 账号恢复操作说明

> 生成时间：2026-11-19 07:30
> 当前状态：App 已弹出登录窗并加载到登录页，等待你完成认证

---

## 一、当前状态（已实测确认）

| 项 | 状态 |
|---|---|
| TeleAgent 进程 | ✅ 运行中（9 个进程） |
| 登录窗 | ✅ 已弹出，加载到 `https://agent.teleai.com.cn/meter/teleagent-login/login` |
| 内核 4397 | ⏸ 未监听（无凭据时不启动内核，正常） |
| token.json | ⏸ 已移出（备份在 `%TEMP%\ta-backup\token.json.current`） |
| 登录方式 | 短信登录 / 扫码登录 / 账号登录，三选一 |
| 推理能力 | ⏸ 当前 token 仍能推理（宽限期至 11-25 04:51），但**已无续期资格** |

---

## 二、你要做的（一步）

**切到 TeleAgent 窗口，完成登录。**

1. 找 TeleAgent 窗口（任务栏/托盘里，标题「TeleAgent 星宸超级智能体」）
2. 右侧登录框选一种方式：
   - **扫码登录** → 手机扫二维码（推荐，最快）
   - **短信登录** → 手机号 + 短信验证码
   - **账号登录** → 天翼账号密码
3. 登录成功后 App 会自动：
   - 重定向到 `/cowork/auth?token=xxx`
   - 从 URL 捕获 token（逆向确认：`route === "auth" && query.token`）
   - 写回 `app-auth/token.json`（DPAPI 加密）
   - 启动内核 4397

**完成后回来告诉我，我验证恢复情况并把 shim 拉起来。**

---

## 三、我已经确认的技术细节

### 3.1 App 如何拿到 token

```js
// app.asar 逆向
const o = wq(t, s);
(o?.route) === "auth" && o.query.token && (m_ = o);
```

登录成功后 URL 变成 `/cowork/auth?token=<JWT>`，App 的登录窗监听 `will-redirect`，
检测到 `route === "auth"` 且有 `token` 参数就捕获。

URL 常量：
```
LOGIN_PAGE = https://agent.teleai.com.cn/superCowork/sapi/cowork/auth
APP_PAGE   = https://agent.teleai.com.cn/meter/teleagent-login/login
```

### 3.2 浏览器登录不能替代

WorkBuddy 内置浏览器 / 你的 Chrome 是独立进程、独立 cookie jar，
登录后 token 只会落到浏览器，不会回传给 App 的 Electron 窗口。

**必须在 App 自己的登录窗里完成。**

### 3.3 恢复后需要重跑的东西

App 启动时会杀 `runtimes/` 目录下的进程：

```
[RuntimeProcessKiller] Killing 2 runtime process(es) under ...\TeleAgent\runtimes [22776, 33404]
[PidManager] Killing existing process with PID: 22776 ...\runtimes\node\node.exe
```

**我的 shim 用的正是 `runtimes\node\node.exe`，所以被误杀。**

恢复后需要重新拉起（见下一节）。

---

## 四、恢复后：shim 重启 + 设计冲突

### 4.1 重启命令

```cmd
cd C:\Users\Administrator\.workbuddy\skills\teleagent-proxy\scripts
node ta-ctl.js start a     # 方案A 8790
node ta-ctl.js start b     # 方案B 8788
```

### 4.2 设计冲突（v2 必须解决）

| | 问题 | v2 的解法 |
|---|---|---|
| shim 用 `runtimes/node/node.exe` | App 启动时按路径杀进程 | **改用系统 Node**（`C:\Program Files\nodejs\node.exe`）或自带运行时 |
| shim 用 `runtimes/python/python.exe` | 同上 | 同上 |
| 方案B 依赖内核 4397 | App 没开就不行 | v2 用方案A（直连网关），不依赖 App |

**实测证据**：App 启动时把 8788（PID 22776）和 8790（PID 33404）都杀了。

这正好印证 v2 的价值 —— **v2 不依赖 TeleAgent App 运行时，也不会被它杀**。

---

## 五、如果不想登录（另一条路）

当前 token **推理仍然正常**（宽限期到 11-25 04:51），只是不能再续期。

如果这 6 天够用，可以先不登录，把 token.json 放回去：

```cmd
copy "%TEMP%\ta-backup\token.json.current" ^
     "%USERPROFILE%\.local\share\TeleAgent\users\v1_public_1903017686270410753\app-auth\token.json"
```

然后重启 App（它会认这个 token，推理正常，但下次续期会 40115）。

**代价**：11-25 之后彻底失效，必须登录。
**好处**：现在什么都不用做。

---

## 六、备份位置

```
%TEMP%\ta-backup\
├─ token.json.bak        07:05 的原始备份
├─ token.json.current    07:19 移出的当前版本（含 App 07:11 重写的内容）
└─ renewal-schedule.json
```

---

## 七、这次操作暴露的三个 v2 设计要点

1. **续期必须原子写回** —— 临时文件 + rename，失败保留旧 token
2. **轮转会作废旧 token** —— 写回前不能假设旧 token 还能用
3. **不能依赖 App 运行时** —— App 会杀 `runtimes/` 下的进程，v2 要自带运行时或用系统的
