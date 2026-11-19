# TeleAgent 反代 v2

把中国电信「超级智能体」桌面客户端的模型能力暴露成标准 API。

**两个模块，一个进程，互不耦合：**

```
┌─ 账号管理模块 (lib/account-manager/) ─────────────┐
│  scan     扫本机 TeleAgent 账号                    │
│  import   导入账号包（bundle / xlsx / json）        │
│  export   导出账号（加密 bundle / xlsx / csv）      │
│  model    账号数据模型                              │
└──────────────────────┬─────────────────────────────┘
                       │  读写 lib/storage/
┌──────────────────────┴─────────────────────────────┐
│  存储层：json（默认，零依赖） / sqlite（需 Node 22+）│
└──────────────────────┬─────────────────────────────┘
                       │  读账号
┌─ 反代服务模块 (lib/proxy/) ─────────────────────────┐
│  server    HTTP 服务（OpenAI / Anthropic 兼容）      │
│  pool      账号池（轮询 / 跳过失效）                  │
│  refresher 凭证续期循环（不依赖 TeleAgent App）       │
│  gateway   直连云网关                               │
│  signer    两轮 HMAC 签名                            │
└────────────────────────────────────────────────────┘
```

---

## 快速开始

```cmd
REM 1) 扫本机账号（装了 TeleAgent 的话）
scripts\start.cmd scan

REM 2) 起反代
scripts\start.cmd serve
```

客户端配置：

```
base_url = http://127.0.0.1:8792/v1
api_key  = teleagent-local
model    = chat-flagship
```

**零依赖**：不需要 `npm install`，不需要装 TeleAgent，Node 18+ 即可。

---

## 搬到别的机器

### 源机器：导出

```cmd
scripts\start.cmd export --out account.bundle --password 你的口令
```

产出 `account.bundle`（已用口令加密）。

### 目标机器：导入 + 启动

```cmd
REM 把整个 teleagent-proxy-v2 目录 + account.bundle 拷过去
scripts\start.cmd import account.bundle --password 你的口令
scripts\start.cmd serve
```

**目标机不需要装 TeleAgent。**

### 目标机没有渠道密钥怎么办

渠道密钥（`sk-...`）所有用户共用，硬编码在 TeleAgent 的 app.asar 里。
目标机没装 TeleAgent 时，把源机提取的密钥放进 `config/channel-key.txt`：

```cmd
REM 源机上执行，输出渠道密钥
node -e "console.log(require('./lib/proxy/gateway').extractChannelKeyFromAsar())"
```

> 不建议手工复制密钥文件 —— 更稳的做法是目标机也装一次 TeleAgent，
> v2 会自动从 app.asar 提取（981MB 文件用分块扫，不会爆内存）。

---

## 命令

### 账号管理

| 命令 | 说明 |
|---|---|
| `tav2 scan` | 扫描本机 TeleAgent 账号并导入 |
| `tav2 import <文件>` | 导入账号包（bundle / xlsx / json） |
| `tav2 export --out <文件>` | 导出（`--format bundle\|xlsx\|csv`） |
| `tav2 accounts` | 查看账号列表 |
| `tav2 accounts rm <id>` | 删除账号 |
| `tav2 accounts disable\|enable <id>` | 禁用/启用 |

### 反代服务

| 命令 | 说明 |
|---|---|
| `tav2 serve` | 启动反代（默认 127.0.0.1:8792） |
| `tav2 refresh` | 立即给快过期的账号续期 |
| `tav2 test "你好"` | 发一条测试消息 |
| `tav2 doctor` | 环境自检 |

### 通用选项

```
--port <端口>      监听端口（默认 8792）
--host <地址>      监听地址（默认 127.0.0.1）
--db json|sqlite   存储类型（默认 json）
--data <目录>      数据目录（默认 ./data）
--password <口令>  凭据库口令 / bundle 解密口令
--format <格式>    导入导出格式
--out <文件>       输出路径
```

---

## 存储

### JSON（默认）

- 单文件 `data/accounts.vault`，AES-256-GCM 加密
- 密钥在 `data/local-key`（32 字节随机），或用口令包裹存 `data/key.wrap`
- 原子写（临时文件 + rename）
- **跨进程安全**：文件锁 + 读-改-写，`scan` 完服务立刻能用新账号

```cmd
tav2 serve --password 你的口令     # 用口令保护凭据库
```

### SQLite（可选，需 Node 22+）

```cmd
tav2 serve --db sqlite
```

用 Node 内置的 `node:sqlite`，无原生模块（换机器不会崩）。
Node 20 会明确报错并提示改用 json。

### Excel

账号列表可以导出成 xlsx 给你看和改（**只含元信息，不含 token**）：

```cmd
tav2 export --format xlsx --out accounts.xlsx
```

xlsx 读写是零依赖自实现（手写 zip + XML），不引入 npm 包。

---

## 凭证自续期

**这是 v2 相对 v1 最核心的改进。**

v1：凭证写死，过期就死。

v2：

- 每 6 小时检查一次，剩余 < 24 小时就续期
- 请求遇到 40114/40105 时**立刻续期并重试**
- 续期失败 3 次 → 标记「需重登」，从池里摘除，**其它账号照常服务**

续期接口（逆向自内核）：

```
POST https://agent.teleai.com.cn/superCowork/sapi/cowork/auth/token-refresh
头：X-Token + X-Timestamp + X-Nonce + X-App-Version + X-OS-Type
    + X-SuperAgent-Device-Id
body：空
```

**无 HMAC、无 Bearer、无设备绑定** —— 不依赖 TeleAgent App。

### ★ 续期会轮转 session

拿到新 token 必须**立刻落盘**。v2 用的是：

1. 抢文件锁
2. 读-改-写
3. 原子替换

写回失败会保留旧 token 降级（宁可晚点死，也不把续期链彻底断掉）。

### 90 天绝对期限

JWT 里的 `abs` 字段是**硬上限**，续期不延长它。到期必须重新登录。

v2 会在 `abs` 临近时提示。**这是设计如此，绕不过。**

---

## 设备指纹

每台机器**本地随机生成** deviceId / installId，不复用原机器的。

原因：服务端不校验指纹（实测全随机仍 200），
同一账号在多台机器上用时，服务端看到的是不同客户端，不触发同设备关联。

---

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI Chat Completions（含 tools） |
| POST | `/v1/messages` | Anthropic Messages |
| POST | `/v1/responses` | OpenAI Responses |
| GET | `/v1/models` | 模型列表 |
| GET | `/health` | 健康检查（含账号池状态） |

自定义 tools 已实测可用 —— 模型返回标准 `tool_calls`，`finish_reason: tool_calls`。

---

## 开机自启

```cmd
scripts\install-task.cmd
```

创建计划任务 `TeleAgent Proxy V2`（登录时启动）。
反代进程不随 WorkBuddy 关闭而结束。

> ⚠️ 别用 TeleAgent 自带的 node（`TeleAgent\runtimes\node\node.exe`）——
> TeleAgent 启动时会杀掉那个目录下的进程，反代会被误杀。
> 计划任务脚本会自动找系统 node。

---

## 目录

```
teleagent-proxy-v2/
├─ bin/tav2.js              CLI 入口
├─ lib/
│  ├─ crypto.js             AES-256-GCM / scrypt / HMAC
│  ├─ dpapi.js              DPAPI 解密（PowerShell 子进程）
│  ├─ xlsx.js               零依赖 xlsx 读写
│  ├─ account-manager/      账号管理模块
│  ├─ storage/              存储层（json / sqlite）
│  └─ proxy/                反代服务模块
├─ config/default.json      配置
├─ scripts/
│  ├─ start.cmd             启动（自动找 node）
│  ├─ install-task.cmd      装计划任务
│  └─ test-*.js             自测脚本
└─ data/                    运行时数据（不要提交到 git）
```

---

## 风险

- 方案 A 本质是「App 外用额度」，违反服务条款 → **账号级封禁**，官方 App 一起失效
- 明文 token 泄露 = 账号沦陷（7 天宽限期内可被冒用）→ 导出包务必加密
- 多账号并行 = 请求频率上升，风控概率上升
- 调试时**每次只发一个请求**，连续大量失败会被判定为攻击行为

## 合规

MIT 许可。使用者需自行确保符合所使用服务商的服务条款。
