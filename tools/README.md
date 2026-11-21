# tools/ —— 辅助脚本

## push-via-api.ps1

通过 **GitHub REST API**（而不是 `git push`）把本地仓库的完整提交历史推到 GitHub。

**为什么需要它**：某些网络环境下 `git` 到 `github.com` 的 HTTPS 通道不通
（代理返回 502、直连超时），但 `api.github.com` 是通的。
这个脚本把 git 对象拆成 GitHub 的 blob / tree / commit 对象再重建引用，
**提交历史和文件内容都不丢**。

```powershell
.\push-via-api.ps1 -Token ghp_xxx
.\push-via-api.ps1 -Token ghp_xxx -Owner myuser -Only v4
```

| 参数 | 说明 |
|---|---|
| `-Token` | GitHub PAT（fine-grained 需 Contents: Read and write） |
| `-Owner` | 目标账号，默认 `xinqian136` |
| `-Only` | 只推匹配的版本目录 |

### 实现要点

**空仓库要先初始化分支。** GitHub 的 Git Data API 对空仓库的 blob 端点返回
`409 Git Repository is empty`。脚本先用 Contents API 写一个 `.gitkeep`
建出 `main` 分支，再开始重建历史。

**blob 按内容去重。** 同一份内容在多个提交里复用同一个 blob，
脚本用 git 的 blob SHA 做 key 缓存，避免重复上传。

**tree / commit 逐个重建。** 按 `git rev-list --reverse HEAD` 的顺序处理每个提交，
用 `git ls-tree -r` 拿文件列表、`git cat-file blob` 拿内容，
通过 API 创建 tree 和 commit，最后 `PATCH` 引用。

### 已知的差异

远端 commit SHA 与本地不同 —— GitHub 在创建 commit 对象时会规范化
author / committer 的时间戳格式。**内容完全一致**（逐 blob SHA 校验）。

## verify-github.ps1

逐文件比对本地与远端，验证推送结果。

```powershell
.\verify-github.ps1 -Token ghp_xxx
```

输出每个仓库的本地文件数、远端文件数、差异数量和差异样本。
`diff = 0` 表示内容完全一致。

### 实现要点

比对时用 `-c core.quotePath=false` 关掉 git 的路径转义 ——
否则中文路径会被转成 `\345\220\257...` 的八进制形式，
和远端返回的真实 UTF-8 路径对不上，会误报成「全部不一致」。

## push-to-github.ps1

标准 `git push` 路径的版本，适合网络正常的情况。

```powershell
.\push-to-github.ps1 -Token ghp_xxx
.\push-to-github.ps1 -Token ghp_xxx -Only v4
.\push-to-github.ps1 -Token ghp_xxx -Private     # 建私有仓库
```

与 `push-via-api.ps1` 的区别：

| | push-to-github.ps1 | push-via-api.ps1 |
|---|---|---|
| 通道 | `git push` | REST API |
| 需要 git 通道通 | 是 | 否 |
| 建仓 `auto_init` | `false`（避免初始提交冲突） | `false` + 手动初始化分支 |
| 凭据 | 命令行临时带，不落 remote | 只在 HTTP 头 |
| 提交历史 | 原样保留 | 重建（时间戳被规范化） |
