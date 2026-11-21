# 05 · 流式与 SSE

流式是「复杂任务失败」这类问题的重灾区。根因往往不是流式本身，
而是**流式标志被吞掉了**，或者**伪流式被当真流式**。

源码：`versions/v4/lib/proxy/sse.js`、`versions/v4/lib/proxy/server.js`

---

## 1. 核心原则

> 客户端要 SSE 就给 SSE（不能吞掉，否则客户端干等到超时）

v3 之前的 bug 就是：

```js
// ❌ 旧代码：把 stream 标志丢掉，客户端等一个永远不会来的流
const gwBody = { ...body };
delete gwBody.stream;      // 或者根本没带
```

表现是「复杂任务失败」：简单请求正常（客户端有超时兜底），
复杂请求（几分钟）客户端先超时断开。

现在：

```js
if (parsed.stream === true) {
  return await handleStream(url, parsed, res);   // ← 真流式分支
}
```

并且在流式分支里**强制**把 stream 设上：

```js
gwBody.stream = true;
```

---

## 2. 真流式 vs 伪流式

| | 真流式 | 伪流式 |
|---|---|---|
| 网关 → 反代 | 边收边转 | 收完再分块吐出 |
| 首个 token 延迟 | 秒级 | 等整个响应完成 |
| 客户端体验 | 打字机效果 | 卡很久然后一次全出 |
| 长任务 | 正常 | 客户端容易超时 |

**本项目是真流式。** 网关返回的是 web stream（`fetch` 的 `r.body`），
不读完就交给调用方：

```js
// lib/proxy/gateway.js
if (o.stream && r.status === 200 && r.body) {
  return { status: r.status, stream: r.body, headers: r.headers, cleanup: () => clearTimeout(timer) };
}
const text = await r.text();     // 非流式才读完
```

对比 v1 的方案 B（内核链路）—— 那是伪流式：
内核一次性返回完整答案，shim 再切片分批吐给客户端。体验差，长任务容易超时。

---

## 3. OpenAI 路径：原始字节透传

网关的 SSE 本身就是 OpenAI 格式，**原样转发，一个字节都不改**：

```js
async function pipeRaw(res, webStream, headers = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',       // ← 关掉 nginx 缓冲
    ...headers,
  });
  if (!webStream) { res.end(); return; }
  const reader = webStream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
      if (res.flush) res.flush();     // ← 立刻刷出去，不要攒着
    }
  } catch (e) {
    try { res.write(`data: {"error":{"message":"..."}}\n\n`); } catch (_) {}
  }
  res.end();
}
```

三个关键点：

| 点 | 为什么 |
|---|---|
| `res.write(Buffer.from(value))` | 保留原始字节，不 decode/re-encode |
| `if (res.flush) res.flush()` | Node 的 socket 攒着数据会导致「看起来不流式」 |
| `X-Accel-Buffering: no` | 前面有 nginx/反代时防止缓冲 |

> `res.flush` 不一定存在（取决于 Node 版本和 socket 类型），
> 所以要判存在再调。

---

## 4. Anthropic 路径：事件流转换

Anthropic 的 SSE 事件序列和 OpenAI 完全不同：

```
message_start
  → content_block_start
    → content_block_delta*      （text_delta / thinking_delta / input_json_delta）
  → content_block_stop
  → message_delta               （stop_reason + usage）
  → message_stop
```

### 转换实现

```js
async function openaiToAnthropicStream(res, webStream, opts = {}) {
  const id = 'msg_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const model = opts.model || 'chat-flash';

  send('message_start', { type:'message_start', message:{ id, type:'message', role:'assistant', model, content:[], stop_reason:null, usage:{input_tokens:0,output_tokens:0} } });
  send('content_block_start', { type:'content_block_start', index:0, content_block:{ type:'text', text:'' } });

  let textStarted = false;
  let toolIndex = -1;
  let toolBlocks = [];

  for await (const ev of readSse(webStream)) {
    if (ev.done) break;
    const j = ev.json;  if (!j) continue;
    if (j.usage) { usage = {...}; }

    const choice = j.choices?.[0];  if (!choice) continue;
    const delta = choice.delta || {};

    // 文本增量
    if (typeof delta.content === 'string' && delta.content.length) {
      send('content_block_delta', { type:'content_block_delta', index:0, delta:{ type:'text_delta', text:delta.content } });
    }

    // 思考内容
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) {
      send('content_block_delta', { type:'content_block_delta', index:0, delta:{ type:'thinking_delta', thinking:delta.reasoning_content } });
    }

    // 工具调用增量（index 对齐）
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let blk = toolBlocks.find((b) => b.index === idx);
        if (!blk) {
          const fn = tc.function || {};
          blk = { index: startToolBlock(tc.id || 'call_'+idx, fn.name || ''), id:tc.id, name:fn.name, rawArgs:'' };
        }
        const args = tc.function && tc.function.arguments;
        if (args) {
          blk.rawArgs += args;
          send('content_block_delta', { type:'content_block_delta', index:blk.index, delta:{ type:'input_json_delta', partial_json:args } });
        }
      }
    }

    if (choice.finish_reason) { ... }
  }

  // 关闭所有块
  send('content_block_stop', { type:'content_block_stop', index:0 });
  for (const b of toolBlocks) send('content_block_stop', { type:'content_block_stop', index:b.index });

  send('message_delta', { type:'message_delta', delta:{ stop_reason:stopReason, stop_sequence:null }, usage });
  send('message_stop', { type:'message_stop' });
  res.end();
}
```

### 工具调用的 index 对齐

Anthropic 的每个内容块有自己的 `index`。OpenAI 的 `tool_calls[].index`
是**工具调用之间的序号**，和内容块的 index 不是一回事。

所以要维护两张表：

```js
// toolBlocks: OpenAI 的 tool index → Anthropic 的 content block index
const blk = toolBlocks.find((b) => b.index === idx);
if (!blk) {
  const idx2 = startToolBlock(...);   // 分配新的 Anthropic index
  blk = toolBlocks.find((b) => b.index === idx2);
}
```

**踩过的坑**：直接拿 OpenAI 的 `tc.index` 当 Anthropic 的 index，
在有文本块 + 工具块混合时会错位 —— 客户端报「content block index 非法」。

### 增量 JSON

OpenAI 的 `tool_calls[].function.arguments` 是**分片**的 JSON 字符串：

```
chunk1: '{"pa'
chunk2: 'th":"a.t'
chunk3: 'xt"}'
```

Anthropic 的 `input_json_delta.partial_json` 恰好也是分片原样透传，
所以**不需要拼接**，直接原样转发即可（客户端自己拼）。

---

## 5. SSE 解析器

```js
async function* readSse(webStream) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });    // ← stream:true，防多字节字符被截断

    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const parsed = parseBlock(chunk);
      if (parsed) yield parsed;
    }
  }
  if (buf.trim()) { const parsed = parseBlock(buf); if (parsed) yield parsed; }
}
```

### 两个细节

**`decoder.decode(value, { stream: true })`** —— 不加 `stream: true`，
一个 UTF-8 字符如果跨 chunk 边界会被截成乱码。

**`parseBlock` 跳过 `:` 开头的行** —— SSE 注释行（keep-alive）要忽略：

```js
function parseBlock(block) {
  let event = null;
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  const data = dataLines.join('\n');
  if (data === '[DONE]') return { event, data, done: true };
  let json = null;
  try { json = JSON.parse(data); } catch (_) {}
  return { event, data, json };
}
```

> 多行 `data:` 要用 `\n` 连接，不能只取第一行。

---

## 6. 流式路径的错误处理

流式的错误分支和普通请求不同 —— **流已经开始了，不能再改 HTTP 状态码**。

```js
if (r.status !== 200 || !r.stream) {
  // 网关在开始流之前就失败了 → 还能改状态码
  const text = r.text || '';
  const e = api.extractError(text, r.status);
  recordResponse(url, 'fail', { status: r.status, code: e.code, ... });

  // 视觉降级重试
  if (hasImage && visionFallback && !visionDowngraded && isVisionUnsupported(e)) { ... }

  res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: { message: `${e.code} ${e.message}`, type: 'upstream_error' } }));
  return;
}

// 流已经开始之后出错 → 只能往流里塞错误事件
```

流开始后的错误，由 `pipeRaw` 的 catch 处理：

```js
} catch (e) {
  try { res.write(`data: {"error":{"message":"${...}"}}\n\n`); } catch (_) {}
}
```

**记住这个规律**：HTTP 状态码只能在响应头发出前改。
流式响应一旦 `writeHead(200)`，后面出错只能走流内错误事件。

---

## 7. 超时设置

复杂任务要几分钟，不能给太短的超时：

```js
timeoutMs: 600000,     // 10 分钟
```

流式路径还要记得清理定时器：

```js
cleanup: () => clearTimeout(timer)
```

并在所有退出路径上调 `r.cleanup()`（成功、失败、降级重试都要调）。

---

## 8. 自测

```cmd
cd versions\v4
node scripts\test-full.js
```

流式相关的验证点：

1. `stream: true` + 短消息 → 应该秒级出 token，不是等完再出
2. `stream: true` + 长任务 → 中途不超时
3. Anthropic 协议 + stream → 事件序列完整，顺序正确
4. 流中途断开 → 不挂死，进程不崩
5. 网关报错（比如无效模型）→ 流式下也能拿到错误信息，不是空挂

---

## 9. 自建时的检查清单

- [ ] `stream` 标志**绝不能吞**
- [ ] 流式分支独立处理，不要复用非流式的逻辑
- [ ] OpenAI 路径尽量原始字节透传
- [ ] `res.flush()` 判存在再调
- [ ] 加 `X-Accel-Buffering: no`
- [ ] `TextDecoder` 用 `{ stream: true }`
- [ ] SSE 解析跳过 `:` 注释行
- [ ] 多行 `data:` 用 `\n` 连接
- [ ] 工具块的 index 要在两套协议间做映射
- [ ] 流开始后的错误只能走流内错误事件
- [ ] 超时给足（复杂任务 10 分钟量级）
- [ ] 所有退出路径都要 cleanup 定时器
