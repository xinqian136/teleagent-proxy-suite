# TeleAgent 本地反代（OpenAI / Anthropic 兼容 API）

把 TeleAgent（电信 AI「超级智能体」桌面 App）的模型能力暴露成标准 API，
让 pi / Cline / Cursor / **Claude Code** / 任何客户端或脚本都能调用。

提供**两条链路**，同时可用：

```
方案 B (8788)  你的工具 → shim → TeleAgent 内核(4397) → 云网关
                        ↑ 出站由 App 进程发出，封号风险低
                        ✗ 不接受自定义 tools

方案 A (8790)  你的工具 → shim → 云网关（直连）
                        ✓ 原生支持自定义 tools（agent 自己控制工具循环）
                        ⚠ 出站是「第二客户端」，封号风险较高
```

**要接 pi / Cline 且需要工具循环 → 用方案 A（8790）。**
详细对比见 [SCHEME-A-B.md](SCHEME-A-B.md)。

**接入配置（Claude Code / Cline / Cursor / pi / SDK 等）见 [INTEGRATION.md](INTEGRATION.md)。**

---

## 从源码安装

```bash
git clone <this-repo> teleagent-proxy
cd teleagent-proxy/scripts

# 1) 解出 safeStorage 的 AES key（DPAPI，Windows 用户级）
"%USERPROFILE%\.local\share\TeleAgent\runtimes\python\python.exe" setup.py

# 2) 启动（用 Windows 计划任务，进程不随终端关闭而结束）
"%USERPROFILE%\.local\share\TeleAgent\runtimes\node\node.exe" ta-ctl.js start a

# 3) 自检
"%USERPROFILE%\.local\share\TeleAgent\runtimes\node\node.exe" ta-ctl.js doctor
```

### 依赖

| 依赖 | 来源 | 说明 |
|---|---|---|
| Node.js | TeleAgent 自带 `runtimes/node/node.exe` | 不需要单独装 |
| Python | TeleAgent 自带 `runtimes/python/python.exe` | 只用标准库 |
| TeleAgent 桌面端 | 官方客户端 | **必须已安装并登录过**（提供凭据与内核） |

> 若 `runtimes/` 不存在，说明 TeleAgent 从未启动过 —— 装一次并登录即可。

### 逆向工具链（可选，仅研究用）

`_re/tools/` 里是还原签名算法时用的脚本，运行时**不需要**。
它们依赖几个可按需重建的工具：

| 工具 | 用途 | 获取方式 |
|---|---|---|
| Go 1.26.x | `debug/gosym` 提符号表 | `golang.google.cn/dl/`（nodejs.org/golang.google.cn 在部分网络环境不可达时用阿里云镜像 `mirrors.aliyun.com/golang/`） |
| capstone + pefile | x86 反汇编、PE 解析 | `pip install capstone pefile` |
| REA | 逆向 agent 工具链（可选） | `npm pack rea-agents` —— **npm 全局安装会被部分沙箱的 safe-delete 回收机制卡死，必须用 `npm pack` 取 tarball 再手动解压** |

---

## 目录

```
teleagent-proxy\
├─ README.md              本文件
├─ INTEGRATION.md         各框架接入配置
├─ WORKBUDDY-SETUP.md     WorkBuddy 接入（UI 字段逐项说明）
├─ SCHEME-A-B.md          两方案对比与选型
├─ scripts\               全部运行时代码
└─ _re\                   逆向研究工具（运行时不需要）
```

---

## 快速开始

### 方案 A（8790）—— 支持自定义 tools

```cmd
scripts\start-tashim-a.cmd
```

前置：TeleAgent **曾经**登录过（token.json 存在）即可，不要求它开着。

### 方案 B（8788）—— 低风险

```cmd
scripts\start-tashim.cmd
```

前置：TeleAgent 已打开并已登录（内核 4397 在监听）。

客户端填：

```
Base URL : http://127.0.0.1:8790/v1
API Key  : teleagent        （本地不校验，随便填）
Model    : chat-pro | chat-lite | chat-flash | chat-flagship | chat-nano
```

对外暴露（局域网 / 另一台机器）：

```cmd
set TA_HOST=0.0.0.0
set TA_API_KEY=你的密钥
scripts\start-tashim.cmd
```

开机自启：`scripts\install-autostart.cmd`
停止：`scripts\stop-tashim.cmd`

---

## 端点

| 端点 | 协议 | 谁在用 |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions | Cline、Roo Code、OpenWebUI、多数客户端 |
| `POST /v1/messages` | Anthropic Messages | **Claude Code**、Cline 的 Anthropic 模式 |
| `POST /v1/responses` | OpenAI Responses | Codex、部分新版 SDK |
| `POST /v1/completions` | OpenAI 旧版 | 老脚本 |
| `GET /v1/models` | OpenAI | 客户端拉模型列表 |
| `GET /health` | — | 探活（免鉴权） |

鉴权：`Authorization: Bearer <key>` 或 `x-api-key: <key>`（两种都认）。
设 `TA_API_KEY` 才校验；不设则本地随便填。CORS 已开，浏览器端工具也能直连。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TA_HOST` | `127.0.0.1` | 设 `0.0.0.0` 对外监听 |
| `TA_PORT` | `8788` | 监听端口 |
| `TA_API_KEY` | 空（不校验） | 开启鉴权 |
| `TA_MODE` | `yolo` | 内核工具执行模式 |
| `TA_AGENT` | 空 | 指定内核里预置的 agent 定义 |
| `TA_KERNEL_URL` | `http://127.0.0.1:4397` | 内核地址 |

---

## 能力

| 能力 | 方案 B (8788) | 方案 A (8790) |
|---|---|---|
| OpenAI / Anthropic / Responses 三种协议 | ✅ | ✅ |
| 多轮对话 | ✅ | ✅ |
| 流式（SSE） | ✅ | ✅ |
| **自定义 tools（标准 tool_calls）** | ❌ | ✅ **原生支持** |
| 工具执行 | 内核自带工具（bash/文件/生图/搜索/MCP） | **你的 agent 自己执行** |
| 工具明细回传 | `tool_execution` | 标准 `tool_calls` |
| CORS / 跨域 | ✅ | ✅ |
| 对外监听（局域网） | ✅ `TA_HOST=0.0.0.0` | ✅ |
| API Key 鉴权 | ✅ `TA_API_KEY` | ✅ |
| 依赖 TeleAgent 开着 | ✅ 必须 | ❌ 不需要 |
| 视觉（`image_url`） | ❌ | ❌ |
| 生图接口 | ❌ | ❌ |

### 实测通过的 agent 循环（方案 A）

```
turn 1 → 模型返回 tool_calls: list_dir {"path": "D://work"}
       → 你的 agent 执行工具，回灌结果
turn 2 → 模型基于回灌结果给出最终回答
```

### 方案 B 的内核自带工具

```
bash, powershell, read, write, edit, multiedit, apply_patch,
glob, grep, codesearch, online_search, websearch, webfetch,
question, todoread, todowrite, image_understanding, ImageGen,
ImageGenWithRef, task, memory_get, memory_search, skill_*, playwright_*
```

实测：让内核在 `D:\` 创建文件并读回校验 → 成功（9.1 秒）。

**返回给客户端的形态**：

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "已完成...",
      "tool_calls": [{
        "id": "call_xxx", "type": "function",
        "function": { "name": "write", "arguments": "{\"input\":{...},\"status\":\"completed\",\"output\":\"...\"}" }
      }],
      "tool_execution": [{ "tool": "write", "status": "completed", "title": "D:\\a.txt" }]
    }
  }]
}
```

---

## 目录

```
teleagent-proxy\
├─ README.md              本文件
├─ INTEGRATION.md         接入指南（各框架配置示例）
├─ SCHEME-A-B.md          两方案对比 + 方案 A 签名算法 + 逆向工具链
├─ scripts\
│  ├─ ta-shim.js            ★ 方案 B 主服务（8788，走内核）
│  ├─ ta-shim-a.js          ★ 方案 A 主服务（8790，直连网关，支持自定义 tools）
│  ├─ ta-api.js              API 层（路由/鉴权/CORS/协议转换）
│  ├─ kernel-client.js        内核调用库（local-v1 签名）
│  ├─ find-sessionkey.py    ★ 提取 + 校验 sessionKey（Python）
│  ├─ ta-token.js             解密登录令牌 / 设备指纹
│  ├─ ta-gateway.js           方案 A 的网关调用（含签名）
│  ├─ ta-gw-sign.js           方案 A 的签名算法（v3 = 3.0.1 正确版）
│  ├─ ta-authstate.js         解密 SUPER_AGENT_AUTH_STATE
│  ├─ start-tashim.cmd      ★ 启动方案 B
│  ├─ start-tashim-a.cmd    ★ 启动方案 A
│  ├─ stop-tashim.cmd         停止
│  ├─ install-autostart.cmd   注册开机自启（计划任务）
│  ├─ session.key             当前 sessionKey（自动生成，勿外传）
│  └─ token.key              safeStorage AES key（勿外传）
└─ _re\                       逆向工具链（研究用，非运行必需）
   └─ tools\
      ├─ gofuncs\main.go      Go 符号表提取器（debug/gosym）
      ├─ go-disasm.py         函数反汇编
      ├─ go-refs.py           rip-relative 字符串引用提取
      ├─ go-strings.py        反汇编 + 字符串/符号注解
      ├─ heap-ctx.py          ★ 堆上找字符串并打印邻近内容（挖运行时配置）
      ├─ dump-json.py         从内存提取完整 JSON 配置
      ├─ find-str.py          找字符串并区分 IMAGE 段 / 堆
      ├─ find-itab.py         搜 Go itab 实例
      └─ wire-headers.py      扫内存找 HTTP 头名
```

---

## 它怎么工作

### 本地鉴权（到内核 4397）

```
payload = "local-v1\n" + METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + NONCE
X-SA-Signature = base64url(HMAC-SHA256(sessionKey, payload))
```

请求头：`X-SA-Sign-Version: local-v1`、`X-SA-Timestamp`、`X-SA-Nonce`、`X-SA-Signature`。

### sessionKey 怎么来的

Electron 主进程启动时生成 32 字节随机密钥，base64url 后交给 Go 内核。
**3.0.1 起这个密钥不再出现在进程环境块里**（改走 stdin 传输，进程 env 会被主动清理），
所以扫环境块的老做法在 3.0.1 上无效。

`find-sessionkey.py` 的做法：

1. 扫 TeleAgent 相关进程内存，收集所有「43 字符 base64url 且解码后正好 32 字节」的字符串；
2. 逐个按 `local-v1` 协议签名调内核 `/provider`；
3. 返回 200 的那个就是真的 sessionKey。

端到端校验，零误判。约 1-3 分钟。

### 自动续期

App 每次重启 sessionKey 都会变。shim 收到 401/403 时自动重新扫内存取新 key 并重试，
无需重启 shim。

### 工具执行模式

内核默认会在危险操作上等权限应答，HTTP 请求会挂住。shim 默认发 `mode: yolo`
（内核的「全自动执行」），无人值守必需。可覆盖：

```cmd
set TA_MODE=yolo          REM 或其它模式（逐步确认会挂住）
set TA_AGENT=<agent名>     REM 指定内核里预置的 agent 定义
```

---

## 已知限制

### 方案 B（8788）

- **不接受调用方自定义 `tools`**。内核跑自己的 agent loop，传入 OpenAI 风格的
  `tools` 定义会被忽略（实测：模型回答「没有名为 get_weather 的工具」）。
  - ✅ 能用**内核自带**的工具（bash/读写文件/生图/搜索/MCP）
  - ❌ 不能注入 pi / Cline 自己那套 read/write/edit
  - → 需要自定义工具链就用**方案 A（8790）**
- 多轮对话靠「历史消息哈希 → 内核会话 ID」映射，**必须原样回传上一轮的 assistant
  消息**，截断或改写会丢上下文。
- 流式是「内核一次性返回后分块模拟」，不是真正的逐 token 流。
- 首次建会话偶发空回复，shim 会自动补发一次。

### 方案 A（8790）

- **403 = 内容审核**。直连网关没有内容审核记录（方案 B 有），某些措辞会被网关侧拦。
  实测「请调用工具 get_weather 查询北京天气」→ 403，
  改成 "Use the get_weather tool for city Beijing" → 200。换个措辞即可，非协议问题。
- **封号风险更高**。见下方风险提示。
- 不支持视觉（`image_url`）与生图接口。

---

## 方案 A 的鉴权算法（3.0.1，已真机验证）

密钥 `K` = JWT 的第三段（签名段）。

```
第一轮（5 段，分隔符 "/"）：
  m1    = "superagent-auth-v1/{token}/{installId}/{ts}/{nonce}"
  sig1  = hex( HMAC_SHA256(K, m1) )

第二轮（7 段，分隔符 "\n"）：
  m2    = "superagent-auth-v1\n{METHOD}\n{path}\n{ts}\n{nonce}\n{appVersion}\n{bodyHash}"
  sig   = hex( HMAC_SHA256(sig1, m2) )      bodyHash = hex(SHA256(body原始字节))
```

要点：
- scheme **全程小写**（3.0.1 没有 `ToUpper`）
- `ts` 是**秒**；`bodyHash` 必须对应真正发出的 body 字节
- `path` = `/superCowork/sapi/api/v1/chat/completions`
- 头名是 `X-SuperAgent-*`（**大写 A**），非 2.5.0 的 `X-Superagent-*`

请求头还有：`Authorization: Bearer sk-<渠道密钥>`（通道密钥）、
`X-Token: <tenant>:<JWT>`、`X-Route-Target: ops-gateway`、`X-Runtime-Env: ctyun_pc`、
`X-App-Version`、`User-Agent: super-agent/1.0`。

代码见 `scripts/ta-gw-sign.js`。逆向过程与工具链见 [SCHEME-A-B.md](SCHEME-A-B.md)。

### 网关返回码

| code | 含义 |
|---|---|
| 200 | 成功 |
| 40101 | missing super agent security headers —— 缺头 |
| 40104 | invalid signature —— 头齐了但签名不对 |
| 40105 | 疑似攻击（风控）—— **立刻停手** |
| 40109 | current user is banned |
| 403 | 内容审核 / 权限 |

> 调试时**每次只发一个请求**。单个 40104 无害，连续大量失败才会被判攻击。

---

## 环境故障排查

### 内核起不来（4397 不监听）

**最常见原因**：`%LOCALAPPDATA%\teleagent-updater\installer.exe` 存在。
那是 App 自动下载的更新包，App 启动时会尝试差分更新，失败后**静默退出**，
内核永远不启动。删掉或改名该文件即可：

```cmd
move "%LOCALAPPDATA%\teleagent-updater\installer.exe" "%LOCALAPPDATA%\teleagent-updater\installer.exe.disabled"
```

其它可能：
- `super-agent-code/bundled/plugin` 缺失（版本不匹配，App 期望 1.2.27）
- 沙箱拦截 `reg.exe` → App 读不到系统代理（日志里 `spawnSync reg EPERM`，是 WARN，不致命）
- App 继承了 `HTTP_PROXY` → 启动前清掉：`unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy`

### sessionKey 提取失败

确认 TeleAgent 正在运行且已登录（内核 4397 在监听）。App 重启后 key 会变，需重跑
`find-sessionkey.py`（shim 也会在 401 时自动重取）。

### 方案 A 报 40101（缺安全头）

检查头名。3.0.1 用的是 `X-SuperAgent-*`（**大写 A**），
不是 2.5.0 的 `X-Superagent-*`。另外 `X-Token` 的值必须是
`<tenant>:<JWT>` 完整形式（`ta-token.js` 已处理）。

### 方案 A 报 40104（签名无效）

签名算法在 `scripts/ta-gw-sign.js`，variant 必须是 **`v3`**：

```
第一轮 '/'  5段：superagent-auth-v1/{token}/{installId}/{ts}/{nonce}
第二轮 '\n' 7段：superagent-auth-v1/{METHOD}/{path}/{ts}/{nonce}/{appVersion}/{bodyHash}
```

常见错因：
- 用了 v1/v2 变体（3.0.1 **没有** `ToUpper`）
- ts 用了毫秒（必须是秒）
- bodyHash 算的不是实际发出的 body（含空格/字段顺序）
- scheme 用了大写

---

## 风险提示

把 App 内额度搬到 App 外使用，**违反服务商服务条款，存在账号被封风险**。
封禁是账号级的——官方 App 会一起失效，不只是反代。

| | 方案 B (8788) | 方案 A (8790) |
|---|---|---|
| 服务端看到的客户端 | 就是 App | 「第二客户端」 |
| 封号风险 | **低**（流量与真人用 App 无法区分） | **较高** |

**降低风险的做法**：

1. 先跑通再放量 —— 调试时每次只发一个请求，看返回码，别批量试
2. 别并发压测，保持人类节奏
3. 别在主号上实验，用小号
4. 控制日用量，别当 7×24 主力通道
5. 需要长期跑 → **用方案 B**

**方案 B 几乎无风险**，只是不能注入自定义 tools。

请仅在自己的机器、自己的账号上小量使用。

