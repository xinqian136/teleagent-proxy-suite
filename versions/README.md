# versions/ —— 四个版本的源码

每个目录是一个**独立迭代版本**，通过 `git subtree` 合入，
**原始提交历史完整保留**。

| 目录 | 版本 | 定位 | 分支 | 提交数 |
|---|---|---|---|---|
| [v1/](v1/) | v1 | 双链路原型：内核链路（低风险）+ 直连网关链路（支持自定义 tools） | `v1` | 4 |
| [v2/](v2/) | v2 | 模块化：账号池、凭证自续期、加密存储、可打包迁移 | `v2` | 3 |
| [v3/](v3/) | v3 | Web 管理后台 + 修流式 / 多模态 / 非流式 500 | `v3` | 11 |
| [v4/](v4/) | v4 | 视觉自动降级 + `chat-flagshipAuto` 模型别名 | `v4` | 3 |

**推荐用 v4**：`cd versions/v4 && node bin/tav3.js web`

---

## 两种看历史的方式

### 方式一：分支（原始历史，路径不带前缀）

每个版本有自己的分支，`git checkout v3` 切过去就是那个版本的干净工作树，
文件在仓库根目录（不是 `versions/v3/`）。

```bash
git checkout v3              # 切到 v3
git log --oneline            # 11 个提交，原始顺序
cd lib/proxy && git log --oneline -- sse.js   # 单文件演进
git checkout main            # 切回
```

### 方式二：main 分支（合并后）

main 分支上是 monorepo 结构，历史全部可达：

```bash
git log --oneline --graph --all
git log --oneline --full-history -- versions/v3
```

### 找某个具体改动

```bash
git show 31e3dea        # v3 修 stream:true 被吞的完整 diff
git show c4a45dc        # v3 撤回远程图缓存
git show e16dd19        # v4 加 chat-flagshipAuto 别名
```

---

## 版本之间的代码关系

```
v1  scripts/ta-shim.js      方案 B：走内核（8788）
    scripts/ta-shim-a.js    方案 A：直连网关（8790）
    scripts/ta-gw-sign.js   签名算法（v4 仍在用，演进成 lib/proxy/signer.js）

v2  lib/proxy/{server,api,gateway,signer,pool,refresher,logger}.js
    lib/account-manager/{scanner,model,exporter,importer}.js
    lib/storage/{json-store,sqlite-store,index}.js
    ← 架构定型，后面都在这个骨架上长

v3  + lib/web/{server,manager,settings}.js + lib/web/public/
    + lib/proxy/sse.js      真流式
    + lib/proxy/media.js    远程图 → base64
    ← 修了 stream 被吞、Anthropic 块格式、非流式 500 三个 bug

v4  = v3 + lib/proxy/api.js 里的 MODEL_ALIASES / resolveModel
    = v3 + lib/proxy/server.js 里的 isVisionUnsupported / 降级重试
    ← 端口 8793/8796，与 v3 错开
```

---

## 各版本的 README

每个目录里都有该版本自己的 README，写的是「怎么用」。
**怎么做的**在仓库根的 [`docs/`](../docs/) 里。

- [v1/README.md](v1/README.md) — 方案 A/B 对比、鉴权算法、内核链路
- [v1/SCHEME-A-B.md](v1/SCHEME-A-B.md) — 两方案选型 + 逆向踩坑
- [v1/INTEGRATION.md](v1/INTEGRATION.md) — 各框架接入配置
- [v1/WORKBUDDY-SETUP.md](v1/WORKBUDDY-SETUP.md) — WorkBuddy 接入（UI 字段逐项）
- [v1/RECOVERY.md](v1/RECOVERY.md) — 恢复流程
- [v1/_re/](v1/_re/) — 逆向研究工具链（运行时不需要）
- [v2/README.md](v2/README.md) — 一键化、客户端填法速查
- [v3/README.md](v3/README.md) — Web 后台功能
- [v4/README.md](v4/README.md) — 视觉降级与模型别名
