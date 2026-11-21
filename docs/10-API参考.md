# 10 · API 参考

以 v4 为准。源码：`versions/v4/lib/proxy/server.js`、`versions/v4/lib/web/server.js`

---

## 1. 对外推理端点

| 端点 | 协议 | 谁在用 |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions | Cline、Roo Code、Cursor、Cherry Studio、多数客户端 |
| `POST /v1/messages` | Anthropic Messages | **Claude Code**、Cline 的 Anthropic 模式 |
| `POST /v1/responses` | OpenAI Responses | Codex、部分新版 SDK |
| `GET /v1/models` | OpenAI | 客户端拉模型列表 |
| `GET /health` | — | 探活（免鉴权） |

### 鉴权

两种头都认：

```
Authorization: Bearer <apiKey>
x-api-key: <apiKey>
```

不设 `apiKey` 则不校验（仅建议本机使用时）。

### CORS

全开，方便浏览器端工具直连：

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Content-Type, Authorization, x-api-key, anthropic-version
Access-Control-Allow-Methods: GET, POST, OPTIONS
```

### 健康检查响应

```json
{
  "ok": true,
  "service": "teleagent-proxy-v2",
  "mode": "direct-gateway",
  "supportsCustomTools": true,
  "accounts": {
    "total": 3, "usable": 2, "needsRelogin": 1,
    "disabled": 0, "expiringSoon": 0,
    "deviceId": "a1b2c3d4e5f6", "installId": "..."
  },
  "version": "2.0.0"
}
```

### 模型列表

```json
{
  "object": "list",
  "data": [
    { "id": "chat-flagship", "object": "model", "created": 0, "owned_by": "teleagent" },
    { "id": "chat-pro",      "object": "model", "created": 0, "owned_by": "teleagent" },
    { "id": "chat-lite",     "object": "model", "created": 0, "owned_by": "teleagent" },
    { "id": "chat-flash",    "object": "model", "created": 0, "owned_by": "teleagent" },
    { "id": "chat-nano",     "object": "model", "created": 0, "owned_by": "teleagent" },
    {
      "id": "chat-flagshipAuto",
      "object": "model", "created": 0, "owned_by": "teleagent",
      "alias": true,
      "desc": "自动：带图走 chat-flash，纯文本走 chat-flagship",
      "vision_model": "chat-flash"
    }
  ]
}
```

带 `alias: true` 的是别名模型。

---

## 2. 请求示例

### 纯文本

```bash
curl http://127.0.0.1:8793/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer teleagent-local" \
  -d '{
    "model": "chat-flagship",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

### 流式

```bash
curl -N http://127.0.0.1:8793/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer teleagent-local" \
  -d '{
    "model": "chat-flagshipAuto",
    "stream": true,
    "messages": [{"role": "user", "content": "写一首五言绝句"}]
  }'
```

### 带图（base64）

```bash
curl http://127.0.0.1:8793/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer teleagent-local" \
  -d '{
    "model": "chat-flagshipAuto",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "图里是什么？"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KG..."}}
      ]
    }]
  }'
```

远程 URL 也行 —— 反代会自动下载转 base64：

```json
{"type": "image_url", "image_url": {"url": "https://example.com/a.png"}}
```

### 带工具

```bash
curl http://127.0.0.1:8793/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer teleagent-local" \
  -d '{
    "model": "chat-flagship",
    "messages": [{"role": "user", "content": "读一下 a.txt"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "读文件",
        "parameters": {
          "type": "object",
          "properties": {"path": {"type": "string"}},
          "required": ["path"]
        }
      }
    }],
    "tool_choice": "auto"
  }'
```

### Anthropic 协议

```bash
curl http://127.0.0.1:8793/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: teleagent-local" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "chat-flagship",
    "max_tokens": 1024,
    "system": "你是一个助手",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

---

## 3. 错误格式

统一 OpenAI 风格：

```json
{
  "error": {
    "message": "网关请求失败：40114 TOKEN_EXPIRED",
    "type": "upstream_error"
  }
}
```

| 状态码 | `type` | 含义 |
|---|---|---|
| 400 | — | 请求体不是合法 JSON |
| 401 | `authentication_error` | API Key 不对 |
| 404 | — | 未知路径 |
| 500 | — | 内部异常（`message` 是异常信息） |
| 502 | `upstream_error` | 网关连接失败或网关报错 |
| 503 | `no_available_account` | 没有可用账号 |

### 503 的详细消息

```json
{
  "error": {
    "message": "没有可用账号（2 个需要重新登录）。请在 TeleAgent 中重新登录后运行 `tav2 scan`。",
    "type": "no_available_account",
    "accounts": { "total": 3, "usable": 0, "needsRelogin": 2, "disabled": 1 }
  }
}
```

---

## 4. 管理 API

前缀 `/api/admin/`，都在 Web 后台端口（默认 8796）上。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/admin/overview` | 概览：账号摘要 + 反代状态 + 设置 + 存储统计 + Node/平台信息 |
| GET | `/api/admin/accounts` | 账号列表（含 token 预览、有效期描述、最后错误） |
| POST/PUT | `/api/admin/account` | 改账号（备注 / 状态 / 手动换 token） |
| DELETE | `/api/admin/account` | 删账号（body: `{id}`） |
| POST | `/api/admin/scan` | 扫描本机账号 |
| POST | `/api/admin/import` | 导入（body: `{content}` 或 `{path}`，可选 `password`） |
| POST | `/api/admin/export` | 导出（body: `{format:'bundle'\|'xlsx'\|'csv'}`） |
| GET | `/api/admin/download?file=` | 下载导出的文件 |
| GET | `/api/admin/settings` | 读设置 |
| POST/PUT | `/api/admin/settings` | 改设置（部分更新） |
| POST | `/api/admin/settings/reset` | 恢复默认设置 |
| GET | `/api/admin/proxy` | 反代状态 |
| POST | `/api/admin/proxy/start` | 启动反代 |
| POST | `/api/admin/proxy/stop` | 停止反代 |
| POST | `/api/admin/proxy/pause` | 暂停反代（**持久化**） |
| POST | `/api/admin/proxy/resume` | 恢复反代 |
| POST | `/api/admin/proxy/restart` | 重启反代 |
| POST | `/api/admin/test` | 对话测试（body: `{message, model}`） |
| GET | `/api/admin/client-config` | 生成各客户端的配置片段 |
| GET | `/api/admin/logs?n=200` | 实时日志 |
| GET | `/api/admin/requests?n=100` | 请求摘要记录 |
| DELETE | `/api/admin/requests` | 清空请求记录 |
| GET | `/api/admin/responses?n=100` | 上游响应记录 |
| DELETE | `/api/admin/responses` | 清空响应记录 |
| POST | `/api/admin/refresh` | 立即给即将到期的账号续期 |

### 反代转发

Web 后台的 `/v1/*` 会**转发**给内部反代服务 —— 所以
`http://127.0.0.1:8796/v1/chat/completions` 和 `:8793/v1/chat/completions` 等价。

反代没运行时返回 503：

```json
{ "error": { "message": "反代服务未运行。请在「反代」页点击启动。", "type": "proxy_stopped" } }
```

---

## 5. 设置项

见 [06 · 部署与运维 §4](06-部署与运维.md#4-配置项全表)。

---

## 6. 命令行

v3/v4 的 `bin/tav3.js`：

```cmd
node bin\tav3.js web          启动 Web 后台（含反代）
node bin\tav3.js serve        只启动反代
node bin\tav3.js accounts     看账号
node bin\tav3.js doctor       环境自检
node bin\tav3.js test "你好"  发条消息
node bin\tav3.js scan         扫本机账号
node bin\tav3.js export --format xlsx
```

v2 的 `bin/tav2.js` 命令名相同。

---

## 7. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TA_CHANNEL_KEY` | — | 直接指定渠道密钥（优先级最高） |
| `TA_DATA_DIR` | `~/.local/share/TeleAgent` | TeleAgent 数据目录（扫描用） |
| `TA_ASAR` | — | 指定 app.asar 路径 |
| `TA_HOST` | `127.0.0.1` | v1 方案：监听地址 |
| `TA_PORT` | `8788` | v1 方案：监听端口 |
| `TA_API_KEY` | — | v1 方案：开启鉴权 |
| `TA_MODE` | `yolo` | v1 方案 B：内核工具执行模式 |
| `TA_AGENT` | — | v1 方案 B：指定内核里的 agent |
| `TA_KERNEL_URL` | `http://127.0.0.1:4397` | v1 方案 B：内核地址 |
