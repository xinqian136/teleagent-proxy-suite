# 方案 A vs 方案 B

两个都在跑，能力不同，风险不同。

| | **方案 B**（`ta-shim.js`，端口 8788） | **方案 A**（`ta-shim-a.js`，端口 8790） |
|---|---|---|
| 链路 | shim → **TeleAgent 内核** (4397) → 云网关 | shim → **云网关**（直连） |
| 出站请求由谁发出 | **TeleAgent App 进程** | 你的 shim |
| 服务端看到的客户端 | 就是 App | 「第二客户端」 |
| **自定义 tools** | ❌ 内核忽略 | ✅ **原生支持** |
| 工具执行者 | 内核自己的 agent loop | **你的 agent** |
| 工具调用回传 | 有（tool_execution） | 标准 OpenAI tool_calls |
| 依赖 TeleAgent 开着 | ✅ 必须 | ❌ 不需要 |
| sessionKey | 需要（每次重启变） | 不需要 |
| 登录令牌 | 不需要 | 需要（token.json 解密） |
| **封号风险** | **低**（流量与真人用 App 无法区分） | **较高**（第二客户端特征） |
| 额度消耗 | 走 App 额度 | 走 App 额度 |

---

## 选哪个

### 用方案 B（8788）—— 默认推荐

- 只想让 AI 帮你写文档、做表格、查资料
- 想用 TeleAgent **自带**的工具（bash / 读写文件 / 生图 / 联网搜索 / Playwright / MCP）
- 在意账号安全
- 不需要「你的 agent 控制工具循环」

### 用方案 A（8790）—— 接 pi / Cline / Cursor

- **你的 agent 框架必须自己管工具循环**（每步审批、工具结果自己回灌、自己决定下一步）
- 需要把 pi 的 read/write/edit/bash 注入模型
- 需要标准 OpenAI `tool_calls` 语义
- 接受更高的封号风险

**两个可以同时跑**，互不干扰。

---

## 方案 A 的鉴权算法（3.0.1）

从内核二进制反汇编 + 运行时环境还原，已真机验证。

### 请求头

```
Authorization: Bearer sk-<渠道密钥>     ← 通道密钥（固定）
X-Token: <tenant>:<JWT>                            ← 用户登录态
X-Route-Target: ops-gateway
X-Runtime-Env: ctyun_pc
X-App-Version: 3.0.1
X-SuperAgent-Timestamp: <10位秒>
X-SuperAgent-Nonce: <uuid v4>
X-SuperAgent-Device-Id: <deviceId>
X-SuperAgent-Install-Id: <installId>
X-SuperAgent-Sign-Version: v1
X-SuperAgent-Signature: <64位小写hex>
User-Agent: super-agent/1.0
Content-Type: application/json
```

### 签名

密钥 `K` = JWT 的第三段（签名段）。

```
第一轮（5 段，分隔符 "/"）：
  m1    = "superagent-auth-v1/{token}/{installId}/{ts}/{nonce}"
  sig1  = hex( HMAC_SHA256(K, m1) )

第二轮（7 段，分隔符 "\n"）：
  m2    = "superagent-auth-v1\n{METHOD}\n{path}\n{ts}\n{nonce}\n{appVersion}\n{bodyHash}"
  sig   = hex( HMAC_SHA256(sig1, m2) )

  bodyHash = hex( SHA256(body原始字节) )
```

要点：
- `ts` 是**秒**
- `bodyHash` 必须对应**真正发出的 body 字节**（含空格与字段顺序）
- scheme 全程**小写**
- `path` = `/superCowork/sapi/api/v1/chat/completions`（不含 query）
- 输出**小写 hex**

代码见 `scripts/ta-gw-sign.js`（`computeSignature(..., variant='v3')`）。

### 网关返回码

| code | 含义 |
|---|---|
| 200 | 成功 |
| 40101 | missing super agent security headers —— 缺头 |
| 40104 | invalid signature —— 头齐了但签名算法/段序不对 |
| 40105 | 疑似攻击（风控）—— **立刻停手** |
| 40109 | current user is banned —— 账号被封 |
| 403 | 内容审核拒绝 / 权限不足 |

> ⚠️ 40104 与 40105 是两回事。单个 40104 是「算法不对」，无害；
> **连续大量** 40104/40105 才会被判为攻击。调试时每次只发一个请求。

---

## 已知的 403（内容审核）

直连网关**没有内容审核记录**（方案 B 有），所以某些措辞会被网关侧拦。

实测触发例：「请调用工具 get_weather 查询北京天气」→ 403；
同样内容改成 "Use the get_weather tool for city Beijing" → 200。

这是平台的内容安全策略，不是协议问题。遇到 403 换措辞即可。

---

## 风险与建议

**方案 A 是「App 外使用」，违反服务条款。** 已知后果：

- 账号级封禁（`40109`），**官方 App 会一起失效**，不是只封反代
- 封禁多为限时（24h～7d），但有永久的先例
- 风控是**累计计数**：连续错误签名的试探、被拒后反复重试，都会推高风险分

降低风险的做法：

1. **先跑通再放量** —— 一次一个请求，看返回码，别批量试
2. **别并发压测**，保持人类节奏
3. **别在主号上实验**，用小号
4. **控制日用量**，别当 7×24 主力通道
5. 需要长期跑 → **用方案 B**

**方案 B 几乎无风险**（出站由 App 进程发出，与真人使用无法区分），
只是不能注入自定义 tools。

---

## 逆向工具链（`_re\tools\`）

| 工具 | 用途 |
|---|---|
| `gofuncs/main.go` | 用官方 `debug/gosym` 提取 Go 二进制符号表（函数名 + 入口 VA） |
| `go-disasm.py` | capstone 反汇编指定函数 |
| `go-refs.py` | 提取 `lea reg,[rip+disp]` 指向的字符串（头名、URL、格式串） |
| `go-strings.py` | 反汇编 + 符号/字符串自动注解 |
| `find-str.py` | 扫进程内存找字符串，区分 IMAGE 段与堆 |
| `heap-ctx.py` | 在堆上找字符串并打印邻近内容（挖运行时配置用） |
| `dump-json.py` | 从内存里提取完整 JSON 配置 |
| `find-itab.py` | 搜 Go itab 实例（判断某函数是否真被调用） |
| `wire-headers.py` / `wire-sig.py` | 扫内存找 HTTP 头名 / 64hex 签名值 |

### 踩过的坑

- **itab 地址**：itab 头是 24 字节（inter/type/hash），`fun[0]` 在 **+24**。
  算错 24 字节会导致「函数是死代码」的误判（我踩过）。
- **Go PE 的 pclntab 在 .rdata**，不是 .text；`textStart` 字段常为 0，用 .text 段 RVA 兜底。
- **`gofuncs.exe` 不传正则只输出前 40 条**，要传 `.*`。
- **环境块里的 secret**：3.0.1 起 `SUPER_AGENT_LOCAL_SESSION_KEY` 不在进程 env，
  改走 stdin 传给 Go 内核 → 扫 env 无效，要扫内存找 43 字符 base64url 候选。
- **内核进程的环境变量**（`OPENCODE_TOOLS_PROVIDER_CONTENT` 等）能从内存里挖到，
  里面有 provider 的 baseURL / apiKey / headers / useSuperAgentAuth —— 这是还原鉴权的捷径。
