# 接入指南

把 TeleAgent 接到你的 agent 框架 / 脚本 / 客户端。

> **两个端口，按需选**：
> - **8788**（方案 B）—— 出站由 TeleAgent App 发出，封号风险低，但**不接受自定义 tools**
> - **8790**（方案 A）—— 直连云网关，**原生支持自定义 tools**（agent 自己控制工具循环），风险较高
>
> 详细对比见 [SCHEME-A-B.md](SCHEME-A-B.md)。**要接 pi / Cline 且需要工具循环 → 用 8790。**

---

## 一、启动

### 方案 B（低风险，推荐日常用）

```cmd
scripts\start-tashim.cmd
```

前置：TeleAgent 已打开并已登录（内核 4397 在监听）。

### 方案 A（支持自定义 tools）

```cmd
scripts\start-tashim-a.cmd
```

前置：只需 TeleAgent **曾经**登录过（token.json 存在），不要求它开着。

### 对外暴露（局域网 / 另一台机器）

```cmd
set TA_HOST=0.0.0.0
set TA_API_KEY=换成你自己的密钥
scripts\start-tashim.cmd        REM 或 start-tashim-a.cmd
```

或直接改脚本里的默认值。

**第一次必须先打开 TeleAgent 并登录**（方案 B 的内核 4397 才会起）。
sessionKey 不用手动跑脚本，shim 会在首次请求时自动取。

开机自启：

```cmd
scripts\install-autostart.cmd
```

---

## 二、端点一览

两个 shim 都提供这些端点：

| 端点 | 协议 | 谁在用 |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions | Cline、Roo Code、OpenWebUI、大多数客户端 |
| `POST /v1/messages` | Anthropic Messages | **Claude Code**、Cline 的 Anthropic 模式、Docker MCP |
| `POST /v1/responses` | OpenAI Responses | Codex、部分新版 SDK |
| `POST /v1/completions` | OpenAI 旧版 | 老脚本 |
| `GET /v1/models` | OpenAI | 客户端拉模型列表 |
| `GET /health` | — | 探活（免鉴权） |

鉴权：`Authorization: Bearer <key>` 或 `x-api-key: <key>`（两种都认）。

**只有 8790（方案 A）支持自定义 `tools`。** 8788 会忽略 `tools` 定义。

---

## 三、各框架怎么填

### Claude Code（Anthropic 协议）

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8790
export ANTHROPIC_AUTH_TOKEN=teleagent-local
claude
```

Windows PowerShell：

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8790"
$env:ANTHROPIC_AUTH_TOKEN = "teleagent-local"
claude
```

> Claude Code 要自己控制工具循环（读文件、改代码、跑命令），
> **必须用方案 A（8790）**，用 8788 会发现工具全是 TeleAgent 自带的。

### Cline / Roo Code（VS Code 插件）

设置 → API Provider → OpenAI Compatible：

```
Base URL : http://127.0.0.1:8790/v1
API Key  : teleagent-local
Model ID : chat-pro
```

### Cursor

Settings → Models → OpenAI API Key：

```
Override OpenAI Base URL : http://127.0.0.1:8790/v1
API Key                  : teleagent-local
```

### Continue（Cline 同类）

`~/.continue/config.json`：

```json
{
  "models": [{
    "title": "TeleAgent",
    "provider": "openai",
    "model": "chat-pro",
    "apiBase": "http://127.0.0.1:8790/v1",
    "apiKey": "teleagent-local"
  }]
}
```

### pi

```bash
pi --provider openai \
   --base-url http://127.0.0.1:8790/v1 \
   --api-key teleagent-local \
   --model chat-pro
```

### OpenAI SDK（脚本）

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8790/v1",
    api_key="teleagent-local",
)
resp = client.chat.completions.create(
    model="chat-pro",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

```bash
curl http://127.0.0.1:8790/v1/chat/completions \
  -H "Authorization: Bearer teleagent-local" \
  -H "Content-Type: application/json" \
  -d '{"model":"chat-pro","messages":[{"role":"user","content":"你好"}]}'
```

### 自定义 tools（方案 A 专属）

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8790/v1", api_key="teleagent-local")

resp = client.chat.completions.create(
    model="chat-pro",
    messages=[{"role": "user", "content": "北京天气怎么样？"}],
    tools=[{
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "查询城市天气",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    }],
)
msg = resp.choices[0].message
if msg.tool_calls:
    call = msg.tool_calls[0]
    args = call.function.arguments        # '{"city": "Beijing"}'
    # 执行你的工具，然后把结果回灌
    client.chat.completions.create(
        model="chat-pro",
        messages=[
            {"role": "user", "content": "北京天气怎么样？"},
            {"role": "assistant", "content": None, "tool_calls": [
                {"id": call.id, "type": "function",
                 "function": {"name": call.function.name, "arguments": args}}]},
            {"role": "tool", "tool_call_id": call.id, "content": "北京：晴 28℃"},
        ],
    )
```

### Anthropic SDK（脚本）

```python
from anthropic import Anthropic

client = Anthropic(base_url="http://127.0.0.1:8790", api_key="teleagent-local")
msg = client.messages.create(
    model="chat-pro",
    max_tokens=1024,
    messages=[{"role": "user", "content": "你好"}],
)
print(msg.content[0].text)
```

### Cherry Studio / LobeChat / NextChat 等

「自定义 OpenAI」类型，填 Base URL + API Key 即可。

---

## 四、模型名

```
chat-pro        最强，日常首选
chat-flagship   旗舰
chat-lite       轻量，快
chat-flash      更快
chat-nano       最快最省
```

不指定或填错会自动回落到 `chat-pro`。

---

## 五、工具执行（重要）

### 方案 A（8790）—— 你的 agent 自己控制

传 OpenAI 风格的 `tools` 即可，模型返回标准 `tool_calls`，你的框架执行完再回灌。
这是 pi / Cline / Cursor 期待的形态。

实测：
- 带 `tools` → 模型返回 `{"name":"get_weather","arguments":"{\"city\": \"Beijing\"}"}`
- 回灌 tool 结果 → 模型正确总结

### 方案 B（8788）—— 内核自己控制

内核跑的是**自己的 agent loop**，工具由它执行，不是你注入的。内置工具：

```
bash / powershell / read / write / edit / multiedit / apply_patch
glob / grep / codesearch / online_search / websearch / webfetch
question / todoread / todowrite
image_understanding / ImageGen / ImageGenWithRef
task / memory_get / memory_search / skill_* / playwright_*(30个)
```

默认 `mode: yolo`（全自动执行）。要改：

```cmd
set TA_MODE=build       REM 逐步确认（会挂住等应答，只适合人工看）
```

**工具调用明细会回传**，客户端可读：

```json
{
  "choices": [{
    "message": {
      "content": "已写入文件",
      "tool_calls": [{
        "type": "function",
        "function": {
          "name": "write",
          "arguments": "{\"input\":{\"filePath\":\"D:\\\\a.txt\"},\"status\":\"completed\",\"output\":\"Wrote file successfully.\"}"
        }
      }],
      "tool_execution": [
        {"tool": "write", "status": "completed", "title": "D:\\a.txt"}
      ]
    }
  }]
}
```

> ⚠️ 方案 B 下，你的 agent 框架的 own tool loop **不会生效** ——
> 模型 → 内核自己选工具 → 内核自己执行 → 结果直接进对话，中间没有你的框架插手。

---

## 五-B、方案 A 的两个坑

**1. 内容审核**

直连网关**没有内容审核记录**（方案 B 有），某些措辞会被网关侧拦（403）。

实测：「请调用工具 get_weather 查询北京天气」→ 403；
改成 "Use the get_weather tool for city Beijing" → 200。

不是协议问题，换措辞即可。

**2. 返回码含义**

| code | 含义 | 处理 |
|---|---|---|
| 200 | 成功 | |
| 40101 | 缺安全头 | 检查头名（`X-SuperAgent-*` 大写 A） |
| 40104 | 签名无效 | 检查 bodyHash / ts 单位 / 段序 |
| 40105 | 疑似攻击 | **立刻停手**，别再试 |
| 40109 | 账号被封 | 停止一切反代，等解封或换号 |
| 403 | 内容审核 / 权限 | 换措辞 |

**调试时每次只发一个请求。** 连续大量失败才会被判攻击，单个 40104 无害。

---

## 六、局域网访问

```cmd
set TA_HOST=0.0.0.0
set TA_API_KEY=你的密钥
scripts\start-tashim.cmd
```

查本机 IP：

```cmd
ipconfig | findstr /c:"IPv4"
```

如果别的机器连不上，八成是防火墙。管理员 PowerShell：

```powershell
New-NetFirewallRule -DisplayName "TeleAgent Shim 8788" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8788 -Profile Any
```

安全提醒：对外暴露时**务必设 `TA_API_KEY`**（默认起服务时没设 key 就是无鉴权）。
另外这个 API 会消耗你的 TeleAgent 额度，且违反服务条款有封号风险——建议只在可信局域网内用。

---

## 七、故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 连接被拒 | shim 没起 | 跑 `start-tashim.cmd`；`netstat -ano \| findstr 8788` 确认 |
| 401 | key 不对 | 检查 `TA_API_KEY` 与客户端填的一致 |
| 500 + 耗时很长 | 内核没起 | 打开 TeleAgent 并登录，确认 `netstat -ano \| findstr 4397` 有 LISTENING |
| 500 + `sessionKey 失效` | App 重启过 | shim 会自动重取；若持续失败重跑 `find-sessionkey.py` |
| 工具不执行 | 权限被拒 | 内核 permission 配置里 `bash` 是 deny，`powershell` 是 allow |
| 卡住不返回 | 内核在等权限应答 | `TA_MODE=yolo` |
| 多轮丢上下文 | 没原样回传上一轮 assistant 消息 | 会话映射靠历史哈希，客户端必须完整回传 |
