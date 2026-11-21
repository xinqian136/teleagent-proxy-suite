# V2 账号扫描机制（实测验证）

> 问题：新机器上 v2 怎么扫到账号？依据安装位置？
> 答案：**扫的是「凭据文件」，不是「安装位置」。但能不能用，取决于加密方案。**

---

## 一、扫什么路径（固定约定，与安装位置无关）

TeleAgent 的**数据目录**与安装目录是分开的：

```
安装位置：C:\Program Files\TeleAgent\        ← 可自定义，不影响数据
数据目录：%USERPROFILE%\.local\share\TeleAgent\   ← 固定约定
```

数据目录里的关键文件：

```
%USERPROFILE%\.local\share\TeleAgent\
├─ Local State                          ← safe_storage 的 DPAPI 密钥来源
├─ app-auth\device-meta.json            ← deviceId / installId（机器级）
└─ users\
   └─ v1_public_<账号ID>\              ← 每个账号一个目录
      └─ app-auth\
         ├─ token.json                 ← ★ 登录令牌
         ├─ local-key                  ← local 方案的密钥（仅 local 方案有）
         └─ renewal-schedule.json
```

**扫描逻辑就是遍历 `users/v1_public_*/app-auth/token.json`**。

不依赖安装位置、不依赖注册表、不依赖 App 进程 —— 只要文件在就能扫到。

---

## 二、扫到了 ≠ 能用（关键区别）

`token.json` 有两种加密方案，**决定了这台机器能不能用这份凭据**：

| scheme | 加密 | 密钥来源 | 跨机器 |
|---|---|---|---|
| `safe_storage` | Electron safeStorage (AES-256-GCM) | `Local State` → DPAPI | ❌ **DPAPI 绑定 Windows 用户 + 机器** |
| `local` | AES-256-GCM | 同目录的 `local-key` 文件 | ✅ **纯随机文件，可复制** |

### 实测验证

**场景 A：模拟新机器（同 Windows 用户，DPAPI 仍可用）**

```
[扫描] users/ 下找到账号目录: 1
[DPAPI] Local State 解密: ok
  AES key = c1e6f7265515c645074b0b523955fc3732212649659064e1cd1afe84b2dd3f56
  ✓ safe_storage 解密成功 → 曾星熠
```

**场景 B：机器上没有 TeleAgent（Local State 已删除）**

```
[DPAPI] Local State 解密: no Local State
  v1_public_1903017686270410753 scheme=local
  ✓ local 方案解密成功 → token 长度 622
```

**结论**：`local` 方案只靠两个文件（`token.json` + `local-key`）就能在**完全没装 TeleAgent 的机器**上解密。

---

## 三、所以 V2 有两种部署形态

### 形态 1：目标机装了 TeleAgent（最省事）

```
目标机装 TeleAgent → 登录一次
  → v2 scan 直接扫 ~/.local/share/TeleAgent/users/
  → 本机 DPAPI 能解 safe_storage → 立刻可用
```

**不需要账号包**，也不需要导出任何东西。

### 形态 2：目标机没装 TeleAgent（真正的"打包带走"）

源机器执行：

```bash
node bin/tav2.js export --out account.bundle
```

产出一个包，内含：

```
account.bundle
├─ accounts.json      账号元信息（tenant / 账号名 / 到期时间）
├─ token.json         加密后的令牌（local 方案）
├─ local-key          32 字节随机密钥
└─ manifest.json      格式版本 + 校验和
```

目标机执行：

```bash
node bin/tav2.js import account.bundle
node bin/tav2.js serve
```

**目标机零依赖** —— 不装 TeleAgent、不需要 DPAPI、不需要 admin 权限。

---

## 四、形态 2 的加密链（为什么能跨机器）

```
源机                                    目标机
────                                    ──────
明文 token                               
  │                                      
  ├─ export 时：                          
  │   生成随机 local-key (32B)          
  │   AES-256-GCM 加密                  
  │   → token.json + local-key          
  │                                      
  └─ import 时：                         
      读 local-key ──┐                  
      读 token.json ─┴→ 解密 → 明文 token → 存入 v2 自己的凭据库
```

**关键点**：整个链条里没有 DPAPI，没有机器绑定。

`local-key` 就是一把随机对称密钥 —— 它和 token 一起走，安全性等价于「文件一起泄露 = 凭据泄露」。

### 所以导出包必须加密

裸导出（token.json + local-key 明文放在一个文件里）**等于把账号交出去**。

v2 的 export 应该支持：

```bash
node bin/tav2.js export --out account.bundle --password "..."
  → 口令派生 key → 整个包再加密一层
```

或者至少：

- 包内文件全部用 `local` 方案（不依赖 DPAPI）
- 包本身可选口令加密
- 导出时警告「这个文件等同于账号密码」

---

## 五、设备指纹的处理

`app-auth/device-meta.json` 里的 `deviceId` / `installId` 是**机器级**的，不跟着账号走。

但实测证明服务端**不校验**它们（全部换成随机值依然 200）。

所以 v2 的做法：

- **不复用**原机器的 deviceId / installId
- 每台机器**本地生成**自己的随机指纹
- 这样多台机器用同一账号时，服务端看到的是「不同客户端」，不触发同设备检测

---

## 六、扫描器设计要点

### 扫描范围

```
1. %USERPROFILE%\.local\share\TeleAgent\users\*\app-auth\token.json   ← 主路径
2. v2 自己的 data/accounts.json                                       ← 导入的账号包
3. 环境变量 TAV2_ACCOUNTS 指定的目录                                    ← 便携模式
```

**不扫描安装位置** —— 装了 TeleAgent 不代表账号在那儿，账号在数据目录。

### 每条记录的处理

```
读 token.json
  ↓
看 scheme
  ├─ safe_storage → 读 Local State → DPAPI 解 AES key → 解密
  │                 （失败 = 这台机器解不开，标记 needsMachineKey）
  └─ local        → 读同目录 local-key → 解密
                    （成功 = 跨机器可用）
  ↓
解出 token → 解析 JWT → 得到 tenant / 账号名 / exp / abs
  ↓
写进 v2 凭据库（自己的加密格式，不依赖 DPAPI）
```

### 降级提示

| 情况 | 提示 |
|---|---|
| safe_storage 且 DPAPI 解不开 | 「此凭据绑定原机器，请在原机器导出，或重新登录」 |
| token 已过期 | 「需重新登录」 |
| `abs` 即将到期（< 7 天） | 「绝对期限临近，到期需重新登录」 |

---

## 七、实测结论汇总

| 问题 | 答案 |
|---|---|
| 扫的是安装位置吗 | ❌ 扫的是 `%USERPROFILE%\.local\share\TeleAgent\users\`（数据目录，与安装位置无关） |
| 新机器没装 TeleAgent 能扫到吗 | ❌ 扫不到（数据目录不存在）→ 需要**导入账号包** |
| 导入的包能解密吗 | ✅ `local` 方案已实测：只有 token.json + local-key，无 TeleAgent、无 DPAPI，解密成功 |
| safe_storage 能跨机器吗 | ❌ DPAPI 绑定 Windows 用户 + 机器 |
| 设备指纹要跟着账号走吗 | ❌ 服务端不校验，每台机器本地生成即可（已实测） |

---

## 八、工具

`_re/tools/probe-newmachine.py` —— 扫描 + 解密可行性验证脚本

```bash
"<python>" probe-newmachine.py [模拟HOME目录]
```

会输出：扫到几个账号 / DPAPI 能否解开 / 每个账号能否解密成功。
