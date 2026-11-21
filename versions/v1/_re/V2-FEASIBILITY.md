# V2 可行性调研结论（2026-11-18）

> 目标：账号扫描 + 账号打包到其它设备使用
> 结论基于本机实测（TeleAgent 3.0.1 / Windows）

---

## 一、决定性发现：设备指纹可以任意伪造

**实测方法**：用 `chat-lite` 发真实请求，只改 `X-SuperAgent-Device-Id` /
`X-SuperAgent-Install-Id`（签名同步改），看服务端认不认。

| 用例 | 结果 |
|---|---|
| 真实 installId + deviceId | 200 |
| 伪造 installId（随机 UUID）+ 真实 deviceId | 200 |
| 伪造 deviceId + 真实 installId | 200 |
| **两个全伪造（全新随机值）** | **200** |

三次连续全 200 复核通过。

**含义**：服务端**不校验设备指纹**。它只认 `X-Token`。

→ **账号凭据可以打包到任意设备使用**，只需要带一个有效的 `X-Token`。
→ 每台设备可以生成自己的随机指纹，互不影响。

---

## 二、凭据分层与可迁移性

| 要素 | 绑定对象 | 可否跨设备 | 证据 |
|---|---|---|---|
| **X-Token**（`tenant:JWT`） | **账号** | ✅ **可**（明文） | 就是 HTTP 头，直接带过去 |
| `deviceId` / `installId` | 无校验 | ✅ 随便填 | 上面的伪造实验 |
| 渠道 key `sk-...` | App 二进制 | ✅ 每台设备各自提取 | 硬编码在 app.asar |
| AES key（token.key） | **DPAPI**（机器+Windows用户） | ❌ **不可** | `CryptUnprotectData` 只在本机本用户可解 |
| `token.json`（密文） | AES key | ❌ 不可（除非同时带 key） | 同上 |

### 所以打包要带的是「明文 token」

```
{
  "tenant": "I7Kp2X",
  "token": "I7Kp2X:eyJhbGciOi...",     ← 明文，可直接用
  "expiresAt": "2026-11-25T04:51:22Z",
  "accountName": "曾星熠",
  "accountId": "1903017686270410753"
}
```

目标设备拿到后，直接填进 `X-Token` 头即可，无需 TeleAgent、无需 DPAPI。

---

## 三、token 有效期

```
iat (签发)  : 2026-11-18 04:51:22
nbf (生效)  : 2026-11-18 04:51:22
exp (过期)  : 2026-11-25 04:51:22      ← 7 天
abs (绝对)  : 2027-02-14 21:49:30      ← 另一套时效，跨度更长
```

- `exp` 是短期令牌，**约 7 天**（实测剩余 150 小时）
- `abs` 字段存在，跨度到 2027-02-14 —— 可能是「账号绝对有效期」或「续期上限」
- 账号目录有 `renewal-schedule.json`（`{"lastAttemptDay": "2026-11-18"}`）
  → **App 会自动续期 token**

**含义**：
- 打包到别的设备后，**7 天内直接可用**
- 7 天后需要刷新 —— 但刷新动作在 TeleAgent App 里做（要 DPAPI + 本机 Local State）
- 所以实际用法是：**源机器保持登录 → 定期刷新 → 重新导出包**

---

## 四、账号扫描：现状与限制

本机 `~/.local/share/TeleAgent/users/` 下只有 **1 个账号目录**
（`v1_public_1903017686270410753`）。扫描脚本已能跑通（`_re/tools/scan-accounts.js`）。

### 「增加其它账号」有两条路

**路 A：在源机器登多个 TeleAgent 账号**
- TeleAgent 支持多账号（每个账号一个 `users/v1_public_<id>/` 目录）
- 逐个登录 → 逐个导出 token → 打包
- ✅ 最稳，不碰内部机制
- ⚠️ 需确认 App 是否支持多账号并存（注销是否会删旧目录）

**路 B：从别处导入 token**
- 直接写入 `users/v1_public_<fakeid>/app-auth/token.json`（用本机 AES key 加密）
- 前提：拿到别的账号的**明文** token
- 明文 token 从哪来？→ 只能从那个账号自己的机器上导出

### 关键限制

**无法凭空造出一个账号的 token** —— JWT 第三段是 HMAC 密钥，
服务端会验签。token 只能从真实登录中产生。

**无法跨设备解密别人的 token.json** —— DPAPI 锁死。

---

## 五、试过但没走通的路：解内核 AuthState

内核环境变量里有 `SUPER_AGENT_AUTH_STATE`（密文 {version,iv,tag,ciphertext}），
Go 侧有 `tool.DecryptAuthState`。

- ✅ 扫内存能拿到完整密文（iv 12 / ct 711 / tag 16 字节，长度自洽）
- ✅ 能拿到 `SUPER_AGENT_LOCAL_SESSION_KEY`
- ❌ **40 组密钥派生组合全部失败**（sessionKey raw / sha256 / md5×2 / HMAC 各种 salt × 4 种 iv 派生）

**为什么放弃**：AuthState 不是必需品。
登录态已经能从 `token.json` 直接解密拿到（方案 A 的 `X-Token` 就是它）。
解 AuthState 只在「不装 TeleAgent 也能拿到登录态」这个场景有价值，
而那个场景用明文 token 导出/导入已经完全覆盖。

脚本保留在 `_re/tools/probe-authstate3.py`，将来要用可以继续试。

---

## 六、V2 功能设计建议

### 1. 账号扫描（`scan`）

```
node ta-ctl-v2.js scan
```
- 列出本机所有 `users/v1_public_*`
- 逐个解密 token，报告 tenant / 账号名 / 有效期 / 剩余时长
- 标出「可导出」与「已过期」

### 2. 账号导出（`export`）

```
node ta-ctl-v2.js export --account <dir> --out <path>
```
- 解出**明文** token，打包成 JSON
- 可选 `--encrypt`：用口令 AES-256-GCM 加密（跨设备安全传输）
- 输出含到期时间，方便目标端判断

### 3. 账号导入（`import`）

```
node ta-ctl-v2.js import --file <path>
```
- 验签前先检查 exp
- 写成本地凭据（不碰 TeleAgent 的目录，用自己的 `accounts.json`）
- 每条记录绑定一个**本地生成的随机 installId/deviceId**

### 4. 多账号反代（`serve`）

```
node ta-ctl-v2.js serve --port 8791
```
- 从 `accounts.json` 读所有账号
- 轮询 / 按权重分配
- 每个请求用该账号的 token 签名
- **过期的自动跳过**
- `/v1/models` 仍返回 5 个模型

### 5. 账号池管理

```
node ta-ctl-v2.js accounts            # 列出
node ta-ctl-v2.js accounts add <file>  # 加一个
node ta-ctl-v2.js accounts rm <id>     # 删一个
node ta-ctl-v2.js accounts refresh     # 重新扫描本机 TeleAgent 刷 token
```

---

## 七、需要的前置条件

| 条件 | 说明 | 必需性 |
|---|---|---|
| 源机器装了并登录过 TeleAgent | 提供 DPAPI + token.json | **必需** |
| 目标机器有 Node.js | 跑 shim | **必需** |
| 目标机器**不需要**装 TeleAgent | v2 自己管凭据和指纹 | ✅ 优势 |
| 源机器保持登录 | 定期刷新 token | 长期使用必需 |
| 知道 App 是否支持多账号并存 | 决定路 A 可行性 | 待验证 |

---

## 八、风险提示（比 v1 更重）

1. **多账号轮询 = 更高频的网关访问** → 风控概率上升
2. **账号共享给他人** → 若对方行为异常，牵连你的账号
3. **明文 token 泄露 = 账号沦陷**（有效期 7 天，可被冒用）
   → 导出包必须加密、传输渠道必须安全
4. **「一个账号多设备」是否被判定异常** —— 未验证
   实测伪造指纹能过，但服务端可能有**频率/并发维度**的关联检测
5. 违反服务条款，账号级封禁风险与 v1 相同

---

## 九、下一步建议

优先级排序：

1. **先做 `export` / `import` / 多账号 `serve`** —— 这三个不依赖任何未知，
   基于已验证的事实（明文 token + 任意指纹）就能实现
2. **验证 App 多账号并存** —— 决定扫描功能的价值
3. **再考虑 AuthState** —— 只在需要「目标机零依赖 TeleAgent 且不传明文 token」时才做

---

## 附：本次调研用到的脚本

| 脚本 | 作用 |
|---|---|
| `_re/tools/scan-accounts.js` | 扫描本机账号 + 可迁移性评估（已跑通） |
| `_re/tools/probe-authstate3.py` | 扫内存取 AuthState 并尝试解密（未解出，保留） |
| `_re/tools/dump-json.py` | 扫内存取环境变量 JSON（已验证有效） |
