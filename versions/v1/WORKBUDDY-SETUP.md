# 在 WorkBuddy 里接入 TeleAgent 反代 —— 操作指南

两种接法，都已实测通过。

| | 方案 A（推荐） | 方案 B |
|---|---|---|
| 端口 | **8790** | 8788 |
| 原理 | 直连云网关 | 走 TeleAgent 内核，出站由 App 进程发出 |
| 自定义 tools | ✅ 原生支持 | ❌ 被内核忽略 |
| 封号风险 | 较高（第二客户端） | 较低（与真人用 App 无法区分） |
| 需要 TeleAgent App | ❌ 不用开着 | ✅ 必须开着且已登录 |

> 下面以**方案 A** 为主写，方案 B 只是把 URL 和模型名换掉。

---

## 一、先把服务跑起来

### 方案 A（8790）

```cmd
scripts\start-tashim-a.cmd
```

或手动：

```cmd
cd C:\Users\Administrator\WorkBuddy\2026-11-18-10-35-09\teleagent-proxy\scripts
set TA_PORT=8790
set TA_API_KEY=teleagent-local
"%USERPROFILE%\.local\share\TeleAgent\runtimes\node\node.exe" ta-shim-a.js
```

### 方案 B（8788）

```cmd
scripts\start-tashim.cmd
```

**验证**（浏览器直接开也行）：

```
http://127.0.0.1:8790/health     → {"ok":true,...}
http://127.0.0.1:8788/health
```

---

## 二、在 WorkBuddy 里添加模型

**路径**：设置 → 模型 → （自定义模型区域）**添加模型**

表单各字段这样填：

### 方案 A

| 字段 | 填什么 |
|---|---|
| **供应商** | `自定义` |
| **模型名称** | `chat-flagship` （这是模型 id，会原样发出去） |
| **接口地址** | `http://127.0.0.1:8790/v1/chat/completions` |
| **API Key** | `teleagent-local` |
| **工具调用** | ✅ 勾上 |
| **图片输入** | ❌ 不勾（网关侧不支持 vision） |
| **思考模式** | ✅ 勾上 |
| **仅思考模式** | ✅ 勾上（模型本身就是推理模型） |
| **允许关闭思考** | ❌ 不勾 |
| **自定义协议** | ✅ **勾上** |
| **默认思考强度** | `自动（使用请求层默认值）` |
| **支持的思考强度** | 全不勾（只展示思考开关，不展示强度选择） |
| **最大输入 Token** | `1000000` |
| **最大输出 Token** | `65536` |

> **接口地址的两种写法都有效**：
> `http://127.0.0.1:8790/v1/chat/completions` 和 `http://127.0.0.1:8790/v1` 都可以。
> WorkBuddy 的 URL 规范化是幂等的（会剥掉结尾的 `/chat/completions` 再补回来），
> 勾了「自定义协议」则原样使用。

### 方案 B

同上，**只改两处**：

| 字段 | 改成 |
|---|---|
| **接口地址** | `http://127.0.0.1:8788/v1/chat/completions` |
| **工具调用** | ❌ 不勾（内核会忽略自定义 tools，勾了也没用） |

---

## 三、三个关键点（容易填错）

### 1. 「自定义协议」必须勾上

WorkBuddy 默认会把接口地址规范化 —— 自动剥掉结尾的 `/chat/completions` 再补回去。
对绝大多数 OpenAI 兼容服务没问题，但**我的 8790/8788 端点本身就是完整路径**，走默认逻辑虽然结果碰巧一样，
勾上「自定义协议」语义更准确（WorkBuddy 官方说明：「开启后将直接使用填写的接口地址，不再自动补全 /chat/completions 路径。适用于代理层或服务端已自行处理协议的场景」）。

填了 `http://127.0.0.1:8790/v1/chat/completions` 也可以**不勾** —— 规范化是幂等的，结果一样。

### 2. 「模型名称」填的是模型 id，不是显示名

填 `chat-flagship` / `chat-pro` / `chat-lite` / `chat-flash` / `chat-nano`，
不要填「旗舰版」这种中文名 —— 它会原样作为 `model` 字段发给网关。

可选 5 个：

| 模型 id | 定位 | 倍率 |
|---|---|---|
| `chat-flagship` | 最强最慢 | 1.0 |
| `chat-pro` | 主力，有推理 + 工具 | 0.6 |
| `chat-flash` | 快，日常够用 | 0.2 |
| `chat-lite` | 无推理，5 秒内 | 低 |
| `chat-nano` | 极简 | 低 |

**注意**：`chat-pro` 偶尔会返回 `50301 负载已满`（网关侧临时拥塞，不是配置问题），
遇到就换 `chat-flagship` 或稍等重试。

### 3. 「图片输入」不要勾

TeleAgent 网关的模型不支持 vision 输入。勾了会导致发图片时直接报错。

---

## 四、添加多个模型（推荐）

WorkBuddy 的模型下拉里每个模型是独立条目，**建议把 2-3 个都加上**，
平时用 `chat-flagship` 或 `chat-pro`，遇到限流或想省钱时切：

- `chat-flagship` —— 主用
- `chat-pro` —— 备用
- `chat-flash` —— 批量/省钱

每个都填同一个接口地址，只是「模型名称」不同。

---

## 五、辅助任务模型（可选但建议）

**路径**：设置 → 模型 → **辅助任务模型**

这个是 WorkBuddy 用来跑「生成标题、会话摘要、增强提示词、记忆筛选」的模型，
默认用官方模型会消耗你的官方额度。指向反代能省额度。

填一个 `chat-flash` 或 `chat-lite` 的条目即可（越便宜越好，它只是干杂活）。

> 注意：辅助任务模型如果选的自定义模型失效，会自动回退到默认模型并弹提示。

---

## 六、验证配置成功

1. 在模型下拉里选中新加的模型
2. 点「**测试连接**」→ 应该弹「连接成功」
3. 发一句话（比如「你好」），看有没有回复

如果测试连接失败，错误码对照：

| 错误 | 原因 |
|---|---|
| `UNREACHABLE` 无法连接到模型服务 | 服务没起，或端口填错（先开浏览器访问 `/health` 确认） |
| `UNAUTHORIZED` API Key 无效 | API Key 与启动时 `TA_API_KEY` 不一致 |
| `NOT_FOUND` 接口地址或模型名称不正确 | 模型名称拼错，或接口地址少了 `/v1` |
| `REQUEST_REJECTED` 模型服务拒绝了测试请求 | 多半是内容审核（见下） |
| `RATE_LIMITED` 请求频率过高 | 网关限流，等会儿再试 |

---

## 七、两个已知坑

### 坑 1：内容审核（403）

直连网关**没有你的使用记录**，网关侧的内容审核可能对某些措辞更敏感。
实测「请调用工具 get_weather 查询北京天气」→ 403，改成「Use the get_weather tool for city Beijing」→ 200。

**不影响正常对话**，只在特定措辞上触发。遇到了换个说法即可。

### 坑 2：流式是「模拟」的

方案 B 的流式是内核一次性返回后分块，不是真逐 token。
方案 A 是网关原生 SSE，是真流式。

---

## 八、开机自启（可选）

```cmd
scripts\install-autostart.cmd
```

注册成计划任务，登录后自动起 shim。

---

## 九、手改 models.json（可选，UI 更快）

文件位置：`C:\Users\Administrator\.workbuddy\models.json`

UI 会自动写这个文件，手改前先备份：

```cmd
copy "%USERPROFILE%\.workbuddy\models.json" "%USERPROFILE%\.workbuddy\models.json.bak"
```

格式（`vendor` 必须是 `Custom`）：

```json
{
  "id": "chat-flagship",
  "name": "chat-flagship",
  "vendor": "Custom",
  "url": "http://127.0.0.1:8790/v1/chat/completions",
  "apiKey": "teleagent-local",
  "supportsToolCall": true,
  "supportsImages": false,
  "supportsReasoning": true,
  "useCustomProtocol": true,
  "onlyReasoning": true,
  "reasoning": { "canDisableThinking": false },
  "maxInputTokens": 1000000,
  "maxOutputTokens": 65536
}
```

改完**重启 WorkBuddy** 才生效。

---

## 十、实测结论

用 WorkBuddy 真实的请求形态（带 `max_tokens` / `reasoning_effort` / `temperature` /
`top_p` / `tools` / `tool_choice` / `stream`）打 8790 端点，**6 项全部 HTTP 200 通过**：

| 用例 | 结果 |
|---|---|
| 基础 + max_tokens | 200 |
| 带 reasoning_effort | 200 |
| 带 temperature + top_p | 200 |
| 带 tools + tool_choice | 200，返回标准 `tool_calls` |
| max_tokens=65536 | 200 |
| stream=true + tools | 200，SSE 正常 |

鉴权也对得上：WorkBuddy 发的是 `Authorization: Bearer <apiKey>`，与实现一致。

---

## 十一、安全提醒

**方案 A 是「把 App 内额度搬到 App 外用」，违反服务商服务条款，存在账号级封禁风险**
（官方 App 会一起失效，不是只封反代）。

**方案 B 风险低得多** —— 出站请求由 TeleAgent 进程发出，服务端看到的就是「App 在正常使用」。

建议：**日常用方案 B，需要 agent 自己控制工具循环时才切方案 A**。
