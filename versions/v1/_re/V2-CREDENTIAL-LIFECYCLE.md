# V2 凭证续期方案（分层设计）

> 回答「定期登录 vs 自动续期」的取舍

---

## 一、结论先说

**两个都要，但它们解决的不是同一个问题：**

| | 自动续期 | 定期重新登录 |
|---|---|---|
| 覆盖 | 7 天 TTL（`exp`） | 90 天绝对期限（`abs`） |
| 频率 | 每 6 小时 | 每 60~90 天 |
| 人工介入 | **无** | 需要扫码 |
| 能不能自动化 | ✅ 已实测可行 | ❌ 登录是 iframe Web App，无法脚本化 |

**分层降级链**：

```
正常态
  │  token-refresh（自动，每 6h）
  ▼
40114 token_expired  ← 可续期，继续自动
  │
  ▼
40115 session_not_found / 40116 session_absolute_expired
  │  ← 终止性错误，自动续期救不了
  ▼
降级：标记账号「需要重新登录」→ 提示用户 → 用户扫码登录
  │  登录后 v2 扫到新 token
  ▼
恢复自动续期
```

**结论**：自动续期消灭 90% 的失效场景（日常 7 天 TTL），
剩下 10%（绝对期限）用提示 + 人工登录兜底。**服务不会死，只是需要人点一下。**

---

## 二、为什么不能两个都自动化

### 2.1 登录走的是 iframe Web App，不是 API

app.asar 里的登录配置：

```js
const jet = "https://agent.teleai.com.cn/meter/teleagent-login/login".trim()
const XM = {
  APP_PAGE:  jet,
  LOGIN_PAGE: `${ys}/cowork/auth`,   // ys = .../superCowork/sapi
}
```

注释写得很清楚：
> 独立部署的登录 Web App。Desktop 和 Web 登录壳都只 iframe 此地址。

登录是 **iframe 里的完整 Web 登录页**（账号密码 / 扫码 / 短信），
最终通过 URL 回调带 `code` 完成。

**没有可以直接调用的「用户名+密码 → token」接口。**

### 2.2 `/api/v1/qrcode/*` 是设备配对，不是登录

```js
pairingGenerate: "/api/v1/qrcode/generate",
pairingScan:     "/api/v1/qrcode/scan",
pairingStatus:   "/api/v1/qrcode/status",
pairingPollIntervalMs: 3e3
// pendingDesktopUnbind
// waitingForMobilePeerBeforeBindingCheck
```

是**手机 ↔ 桌面**的设备绑定流程（`pendingDesktopUnbind`、
`waitingForMobilePeerBeforeBindingCheck`），产出的是配对凭据，
不是登录 token。**用不上。**

### 2.3 `/iam/login` 是客服窗口的重定向

```js
u.startsWith("/iam/login") ? (W4 = !1,
  nu.warn(" Redirected to IAM login page, app session not effective for customer service:", l))
```

是客服 iframe 检测会话有效性用的，与主登录流无关。

---

## 三、为什么「定期登录」不能替代自动续期

假设只做「定期登录」，那意味着：

- token 7 天过期 → **每 7 天都要人工扫码一次**
- 7 天 × 一年 = 52 次扫码

显然不可接受。

自动续期把这件事降到 **0 次人工**（直到 90 天上限）。

---

## 四、续期接口细节（已实测）

```
POST https://agent.teleai.com.cn/superCowork/sapi/cowork/auth/token-refresh

Content-Type          : application/json
X-Token               : <当前 token>
X-Timestamp           : <Unix 秒>
X-Nonce               : <UUID>
X-App-Version         : 3.0.1
X-OS-Type             : Windows
X-SuperAgent-Device-Id: <任意>

body: (空)

→ 200 {"code":0,"message":"ok","data":{"accessToken":"<新token>","expiresIn":...}}
```

**无 HMAC、无 Bearer、无设备绑定。**

### 4.1 ★ 续期会轮转 session（必须原子写回）

实测：

```
旧 token 推理        → 200 OK      （宽限期仍可用）
旧 token 再续期      → 401 40115 session not found
```

即：**一次续期只能用一次**，拿到新 token 必须立刻保存。
写回失败 = 续期链断裂 = 只能等旧 token 自然过期。

**v2 必须**：
1. 先写临时文件
2. 成功后原子 rename 到正式位置
3. 失败则保留旧 token（降级但服务不中断）

### 4.2 错误码分类（决定降级策略）

```
40112 MISSING_ACCESS_TOKEN      → terminal（需重登）
40113 SIGNATURE_INVALID         → terminal（需重登）
40114 TOKEN_EXPIRED             → 非终止，可续期
40115 SESSION_NOT_FOUND         → terminal（需重登）
40116 SESSION_ABSOLUTE_EXPIRED  → terminal（需重登）← 90 天
50005 TEMPORARILY_UNAVAILABLE   → retryable（稍后重试）
```

App 的 `OEt()` 映射里，`40114` 单独归类，其它都是终止性。

**v2 的判断逻辑**：

```js
if (40114 || 50005) → 自动重试（续期后重发）
if (40112/40113/40115/40116) → 标记 needsRelogin，提示用户
```

---

## 五、v2 的完整凭证生命周期

```
                    ┌──────────────────────────────────────┐
                    │         v2 凭证管理器                 │
                    └──────────────────────────────────────┘
                                    │
   启动 ──▶ scan ──▶ 载入凭据库 ──▶ 健康检查 ──▶ 进入池
                                    │
                          ┌─────────┴─────────┐
                          │  token 未过期      │ token 已过期/无效
                          ▼                   ▼
                    直接使用            尝试自动续期
                                          │
                              ┌───────────┼───────────┐
                              ▼           ▼           ▼
                          200 成功    40114/50005   40115/40116
                              │           │           │
                          写回新token  重试3次    needsRelogin
                              │           │           │
                              │        仍失败      提示用户扫码
                              ▼           ▼           │
                          正常使用     标记降级        │
                                                      │
                              重新登录后 ──▶ scan ──────┘
```

### 定时续期

```
每 6 小时检查一次（对应 7 天 TTL，约 28 次/天）
  exp - now < 24h  →  主动续期
  续期成功 → 原子写回
  续期失败 → 连续 3 次标记 needsRelogin
```

### 请求时兜底

```
收到 401/40104 → 立即续期 → 重发一次
                 ↓ 仍失败
              换池中下一个账号（多账号场景）
                 ↓ 都不可用
              返回明确错误「需要重新登录账号 X」
```

**绝不因为单个账号失效就让整个服务死掉** —— 这是 v2 相对 v1 最核心的改进。

---

## 六、需要提示用户的信息

当账号进入 `needsRelogin` 状态，v2 应该：

1. **日志明确写出**：哪个账号、什么原因（40115 还是 40116）、怎么解决
2. **`/health` 暴露状态**：
   ```json
   {
     "ok": true,
     "accounts": [
       { "id": "acc_1", "status": "active", "expiresAt": "..." },
       { "id": "acc_2", "status": "needsRelogin", "reason": "40116 absolute expired" }
     ]
   }
   ```
3. **提供一个命令**：`node bin/tav2.js login` → 输出登录指引 + 二维码/URL
4. **服务不中断**：其它账号继续服务，单账号降级只影响它的流量

---

## 七、90 天绝对期限的处理

`abs` 字段实测值：`2027-02-14`（相对当前 2026-11-18，约 90 天）。

**v2 无法绕过**，但可以：
- 提前 7 天预警（`abs - now < 7d` 时日志提示）
- 到期前 24 小时主动续期（万一服务端允许宽限）
- 到期后明确提示需要重新登录

**重新登录 = 新 session = 新的 90 天**。所以理论上这个周期可以无限续下去，
前提是有人每 90 天点一次。

---

## 八、最终建议

**按我说的方式做（自动续期为主），但把「提示重新登录」作为内置降级路径。**

具体：
1. 自动续期循环 —— 消灭日常失效（占 99%）
2. 401 即时续期重试 —— 消灭边界失效
3. needsRelogin 状态机 —— 优雅降级，不死服务
4. `login` 命令 —— 把「重新登录」做成一键操作（打开登录页 + 轮询 token.json）
5. 90 天预警 —— 提前告知

**用户体验**：一年只需要人工干预约 4 次（每 90 天一次），其余全自动。

---

## 九、待验证

| 事项 | 影响 |
|---|---|
| 续期接口的频率限制（当前只测了连续 3 次，都返回 40115 因为 token 已轮转） | 决定续期间隔设多少 |
| `40114` 的真实触发场景 | 验证「可续期」分类在实际中的表现 |
| 重新登录后旧账号目录是否复用 | 影响 scan 的匹配逻辑 |
| 续期是否消耗「绝对期限」 | 决定 90 天是滑动还是固定 |

### 第 1 项的补充说明

之前测「连续续期 3 次」全部返回 40115，**不是频率限制**，
而是第一次成功续期后 session 就轮转了，后两次拿的是已作废的旧 token。
**频率限制尚未真正测试**（需要用每次续期返回的新 token 连测）。
