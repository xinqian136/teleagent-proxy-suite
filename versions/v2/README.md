# TeleAgent 反代 v2

把「超级智能体」桌面端的模型能力，变成你客户端里能填的一行地址。

---

## 三步搞定

### 1️⃣ 双击 `启动.cmd`

第一次会自动扫描本机账号，然后起服务。

### 2️⃣ 复制这三行，填进你的 AI 客户端

```
Base URL : http://127.0.0.1:8792/v1
API Key  : teleagent-local
Model    : chat-flagship
```

> 想知道 Cherry Studio / Cline / Cursor 各自怎么填？打开自动生成的 **`客户端配置.txt`**，
> 里面每个客户端的填法都写好了，照抄即可。

### 3️⃣ 完事

---

## 客户端填法速查

| 客户端 | 在哪填 |
|---|---|
| **Cherry Studio** | 设置 → 模型服务 → 添加「OpenAI 兼容」服务 |
| **Cline / Roo Code** | 设置 → API Provider → OpenAI Compatible |
| **Cursor** | 设置 → Models → OpenAI API Key → Override Base URL |
| **WorkBuddy** | 设置 → 自定义模型 / OpenAI 兼容 |

模型名可选：`chat-flagship`（最强）、`chat-pro`、`chat-lite`、`chat-flash`（最快）、`chat-nano`。

---

## 换一台机器用

**源机器**：双击 `导出账号.cmd` → 得到 `account.bundle`

**目标机器**：
1. 把**整个文件夹** + `account.bundle` 一起拷过去
2. 双击 `导入账号.cmd`（会自动找包、自动导入、自动配好渠道密钥）
3. 双击 `启动.cmd`

目标机**不需要装 TeleAgent**，不需要 `npm install`，只要有 Node 18+。

---

## 日常维护

| 双击这个 | 干什么 |
|---|---|
| `启动.cmd` | 起服务 |
| `检查状态.cmd` | 看账号状态 + 环境自检 |
| `导出账号.cmd` | 导出账号包 |
| `导入账号.cmd` | 导入账号包 |

**开机自启**（可选）：跑一次 `scripts\install-task.cmd`，登录后自动启动。

---

## 出问题了怎么办

**先双击 `检查状态.cmd`**，它会告诉你哪儿不对。

| 症状 | 原因 | 怎么办 |
|---|---|---|
| 提示端口被占用 | 服务已经在跑了 | 正常，不用管 |
| 没有可用账号 | 凭证过期或账号被摘 | 在 TeleAgent 里重新登录，再双击 `启动.cmd` |
| 渠道密钥未找到 | 没装 TeleAgent 且没导入过 | 双击 `导入账号.cmd` |
| Node.js not found | 没装 Node | 装 Node 18+：https://nodejs.org |

---

## 它是怎么工作的

```
你的客户端  →  127.0.0.1:8792  →  v2  →  云网关  →  模型
                                    ↑
                              凭证自己续期
```

- **凭证自续**：每 6 小时检查，快过期就自动续。不用你管。
- **账号池**：多个账号轮着用，某个失效了自动跳过，**不影响其它**。
- **设备指纹**：每台机器本地随机生成，不复用原机器的。

---

## 目录结构

```
teleagent-proxy-v2/
├─ 启动.cmd              ← 双击这个
├─ 导出账号.cmd          ← 双击这个
├─ 导入账号.cmd          ← 双击这个
├─ 检查状态.cmd          ← 双击这个
├─ 客户端配置.txt        ← 自动生成，照着填客户端
├─ bin/tav2.js           命令行入口（进阶用）
├─ lib/
│  ├─ account-manager/   账号管理：扫描 / 导入 / 导出
│  ├─ storage/           存储：加密 JSON（默认）/ SQLite（可选）
│  └─ proxy/             反代：服务 / 账号池 / 续期 / 签名
├─ config/
├─ data/                 运行时数据（别删！续期链靠它）
└─ scripts/
```

---

## 进阶：命令行

```cmd
node bin\tav2.js serve                    起服务
node bin\tav2.js accounts                 看账号
node bin\tav2.js doctor                   环境自检
node bin\tav2.js test "你好"              发条消息
node bin\tav2.js scan                     扫本机账号
node bin\tav2.js export --format xlsx     导出成 Excel 看
```

---

## 注意

- **别删 `data/` 目录** —— 那是续期链的命根子，删了凭证就断了。
- `account.bundle` **等同于账号密码**，别乱发。
- 90 天后需要重新登录一次（服务端硬期限，自动续期也延长不了）。
- 本工具的使用者需自行确保符合所使用服务商的服务条款。
