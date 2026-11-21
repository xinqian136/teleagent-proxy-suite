# V2 架构方案（2026-11-18）

> 目标：打包到任意机器 → 本地扫描 → 有账号就反代 → **凭证永不过期**
> 状态：全部关键环节已实测通过

---

## 一、核心突破：续期可以自己实现

### 1.1 App 确实会自动续期

主日志实证：

```
[AuthRenewal] token-refresh succeeded ttl=604799s operTokenSeeded=changed
[AuthRenewal] scheduled renewal (timer) succeeded
```

- `ttl=604799s` = 7 天
- 触发时机：**启动时** + **定时器**
- 错误分类：`missing_token` / `signature_invalid` / `token_expired` /
  `session_not_found` / `session_absolute_expired`（90 天绝对期限）

### 1.2 续期接口可以独立调用（关键）

逆向自 app.asar：

```
base = https://agent.teleai.com.cn/superCowork/sapi
path = /cowork/auth/token-refresh

POST <base><path>
Content-Type     : application/json
X-Token          : <当前 token>
X-Timestamp      : <Unix 秒>
X-Nonce          : <UUID>
X-App-Version    : 3.0.1
X-OS-Type        : Windows
X-SuperAgent-Device-Id : <任意>
body             : 空

→ 200 {"code":0,"data":{"accessToken":"<新token>","expiresIn":...}}
```

**没有 HMAC、没有 Bearer、没有设备绑定。**

实测：

```
✓ 续期成功，新 token 过期: 2026-11-25 23:06:05
  与旧 token 相同? 否（已轮转）
```

### 1.3 续期后的新 token 直接可用于网关

```
✓ 推理成功: 我是Z.ai开发的GLM大语言模型…
（用的是全新随机 deviceId + installId）
```

**→ v2 可以完全自持：扫一次 token，之后自己续期，永不需要 TeleAgent App。**

---

## 二、跨设备的两条路

### 路 A：`local` 加密方案（推荐）

app.asar 显示 token.json 支持两种 scheme：

| scheme | 加密 | 密钥来源 | 跨设备 |
|---|---|---|---|
| `safe_storage` | Electron safeStorage | DPAPI（Local State） | ❌ 机器+Win用户绑定 |
| **`local`** | **AES-256-GCM** | **`app-auth/local-key` 文件** | ✅ **纯随机文件，可复制** |

`local` 方案参数（逆向确认）：

```
算法   aes-256-gcm
key    32 字节 = local-key 文件内容
nonce  12 字节
tag    16 字节
格式   base64( nonce | ciphertext | tag )
```

`local-key` 由 `VBe(path, createIfMissing)` 管理 —— 不存在就 `randomBytes(32)` 写入。
**与机器、账号、Windows 用户全都无关。**

→ **打包时带上 `local-key` + `token.json`（local 方案），目标机直接可用。**

### 路 B：直接导出明文 token

```
{ "tenant": "...", "token": "tenant:JWT", "expiresAt": "...", ... }
```

目标机直接填 `X-Token` 头。更简单，但明文传输有泄露风险 → 建议用口令加密。

---

## 三、v2 功能设计

### 目录（全新，不碰 v1）

```
teleagent-proxy-v2/
├─ SKILL.md
├─ V2-ARCHITECTURE.md        本文件
├─ bin/
│  ├─ tav2.js                ★ 主 CLI
│  └─ ...
├─ lib/
│  ├─ credentials.js         凭据存储（加密）
│  ├─ scanner.js             本地账号扫描
│  ├─ refresher.js           续期循环
│  ├─ gateway.js             直连网关
│  ├─ signer.js              两轮 HMAC
│  ├─ pool.js                多账号池
│  └─ api.js                 OpenAI/Anthropic 协议层
└─ data/
   ├─ accounts.json           凭据库（加密）
   └─ local-key               32 字节随机密钥
```

### 核心流程

```
        ┌──────────────── 目标机器（无需装 TeleAgent）────────────────┐
        │                                                             │
  启动  │  ① 扫描                                                    │
        │     ├─ 本机有 TeleAgent → 读 token.json                    │
        │     │    ├─ safe_storage → 用本机 DPAPI 解                 │
        │     │    └─ local        → 用 local-key 解                 │
        │     └─ 无 TeleAgent → 读 data/accounts.json（打包带来）    │
        │                        ↓                                   │
        │  ② 续期循环（每 6 小时）                                    │
        │     POST /cowork/auth/token-refresh → 新 token 写回         │
        │                        ↓                                   │
        │  ③ 反代 :8791                                              │
        │     收到请求 → 从池里挑个有效账号 → 签名 → 发网关            │
        │                     ↓                                      │
        │              401/过期 → 立刻续期 → 重试                      │
        └─────────────────────────────────────────────────────────────┘
```

### CLI

```bash
node bin/tav2.js scan                 # 扫描并导入本机账号
node bin/tav2.js import <file>        # 导入打包的账号
node bin/tav2.js export --out <file>  # 导出账号（含 local-key，可选加密）
node bin/tav2.js accounts             # 列出账号池
node bin/tav2.js accounts rm <id>     # 删除
node bin/tav2.js refresh              # 手动续期一次
node bin/tav2.js serve --port 8791    # 启动反代
node bin/tav2.js doctor               # 环境自检
```

---

## 四、v1 vs v2 对比

| | v1 | v2 |
|---|---|---|
| 账号来源 | 本机 TeleAgent | 本机扫描 **+ 打包导入** |
| 目标机需装 TeleAgent | ❌ 方案A 不需要<br>✅ 方案B 需要 | **完全不需要** |
| 凭证过期 | **服务死** | **自动续期，永不过期** |
| 凭证存储 | 写死在 token.json | 自己的加密凭据库 |
| 设备指纹 | 读本机 device-meta.json | **本地随机生成**，每机独立 |
| 通道密钥 | 从 app.asar 提取 | 同（随包带走或目标机提取） |
| 多账号 | ❌ | ✅ 账号池 + 轮询 |
| 依赖 DPAPI | 是（safe_storage） | 否（用 local 方案或明文） |

---

## 五、仍需确认的点

| 事项 | 状态 | 影响 |
|---|---|---|
| **90 天绝对期限**（`session_absolute_expired`） | 已知存在，未测边界 | 超过 90 天可能强制重登，v2 无法绕 |
| App 是否支持多账号并存 | 目录名带账号ID + 有 accountSwitch 代码 | 大概率支持，未实测 |
| 续期接口有无频率限制 | 未测 | 可能触发风控，需保守设置间隔 |
| 一个账号多设备是否被判异常 | 指纹可伪造（已验），但频率/并发维度未验 | 风险点 |
| 渠道密钥是否所有版本通用 | 当前 3.0.1 验证过 | 升级后需重提取 |

---

## 六、风险提示

1. **续期接口被封** → v2 退化成 v1 的过期问题。建议保留降级路径
2. **多账号轮询 + 续期** → 请求频率上升，风控概率上升
3. **明文 token 泄露 = 账号沦陷** → 导出必须加密
4. **90 天绝对期限** → 这是硬上限，v2 也解决不了
5. 违反服务条款，账号级封禁风险与 v1 相同

---

## 七、建议实施顺序

1. **credentials + scanner + refresher + gateway**（核心，自持闭环）
2. **export/import**（打包分发，带加密）
3. **pool + serve**（多账号）
4. **doctor + 自愈**（续期失败重试、401 立即续期重发）

### 关键设计决策

- **续期提前量**：到期前 24 小时主动续，留足重试余量
- **续期间隔**：默认 6 小时（对应 7 天 TTL，约 28 次/天）
- **失败处理**：连续 3 次失败 → 标记账号不可用 → 池里剔除 → 不影响其它账号
- **401 即时续期**：网关返回 401/40104 → 立刻续期重试一次（而不是等下次定时）
- **凭据库加密**：用 `local-key` 同款 AES-256-GCM，key 单独文件
