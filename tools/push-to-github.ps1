# ============================================================
#  push-to-github.ps1 — 把四个版本推到 GitHub
#
#  用法:
#    .\push-to-github.ps1 -Token ghp_xxx
#    .\push-to-github.ps1 -Token ghp_xxx -Only v4
#
#  会为每个版本在 GitHub 上建同名仓库（不存在则创建），
#  把当前分支和完整提交历史推上去。
#
#  PAT 权限要求（fine-grained token）：
#    Repository access : 选中你的账号
#    Contents          : Read and write
#    Administration    : Read and write   <- 建仓需要
#  或用 classic token，勾选 repo scope。
# ============================================================
param(
  [Parameter(Mandatory=$true)][string]$Token,
  [string]$Only = "",
  [switch]$Private,
  [switch]$SkipCreate
)

$ErrorActionPreference = "Continue"

# PS 5.1 默认不启用 TLS 1.2，GitHub API 会报「未能建立 SSL/TLS 安全通道」
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$owner = "xinqian136"

# git 不一定在 PowerShell 的 PATH 里，先探测
function Find-Git {
  $c = Get-Command git -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $cands = @(
    "$env:ProgramFiles\Git\cmd\git.exe",
    "${env:ProgramFiles(x86)}\Git\cmd\git.exe",
    "$env:ProgramFiles\Git\bin\git.exe",
    "${env:ProgramFiles(x86)}\Git\bin\git.exe",
    "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe"
  )
  foreach ($c2 in $cands) { if ($c2 -and (Test-Path $c2)) { return $c2 } }
  return $null
}
$gitExe = Find-Git
if (-not $gitExe) {
  Write-Host "找不到 git.exe，请把 Git 加入 PATH 或装 Git for Windows。" -ForegroundColor Red
  exit 1
}
Write-Host "git: $gitExe" -ForegroundColor DarkGray

$projects = @(
  @{ dir = "teleagent-proxy";    name = "teleagent-proxy";    desc = "TeleAgent reverse proxy v1 - direct gateway / app-process modes, OpenAI + Anthropic compatible API" },
  @{ dir = "teleagent-proxy-v2"; name = "teleagent-proxy-v2"; desc = "TeleAgent reverse proxy v2 - CLI version" },
  @{ dir = "teleagent-proxy-v3"; name = "teleagent-proxy-v3"; desc = "TeleAgent reverse proxy v3 - web admin console" },
  @{ dir = "teleagent-proxy-v4"; name = "teleagent-proxy-v4"; desc = "TeleAgent reverse proxy v4 - web console + vision auto-fallback + chat-flagshipAuto alias" }
)

$headers = @{
  "Authorization"        = "Bearer $Token"
  "Accept"               = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent"           = "teleagent-proxy-push"
}

function Test-Repo([string]$Name) {
  try {
    $null = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$Name" -Headers $headers -Method Get -ErrorAction Stop
    return $true
  } catch { return $false }
}

function New-Repo([string]$Name, [string]$Desc) {
  $body = @{ name = $Name; description = $Desc; private = [bool]$Private; auto_init = $false } | ConvertTo-Json
  try {
    $null = Invoke-RestMethod -Uri "https://api.github.com/user/repos" -Headers $headers -Method Post -Body $body -ContentType "application/json" -ErrorAction Stop
    Write-Host "  [+] created $owner/$Name" -ForegroundColor Green
  } catch {
    Write-Host "  [!] create failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "      create an empty repo manually, then rerun: https://github.com/new" -ForegroundColor Yellow
    return $false
  }
  return $true
}

# 凭据只在本次 git push 命令行里使用，不写入 remote / .git/config
foreach ($p in $projects) {
  if ($Only -ne "" -and $p.dir -notlike "*$Only*") { continue }
  $dir = Join-Path $root $p.dir
  if (-not (Test-Path $dir)) {
    Write-Host "skip $($p.dir) (not found)" -ForegroundColor DarkGray
    continue
  }

  Write-Host ""
  Write-Host "=== $($p.dir) ===" -ForegroundColor Cyan

  if (-not (Test-Repo $p.name)) {
    if ($SkipCreate) {
      Write-Host "  [!] repo missing and -SkipCreate given, skipped" -ForegroundColor Yellow
      continue
    }
    if (-not (New-Repo $p.name $p.desc)) { continue }
  } else {
    Write-Host "  [=] repo exists: $owner/$($p.name)" -ForegroundColor DarkGray
  }

  Push-Location $dir
  try {
    $remote = "https://github.com/$owner/$($p.name).git"
    $existing = @(& $gitExe remote 2>$null)
    if ($existing -contains "origin") {
      & $gitExe remote set-url origin $remote
    } else {
      & $gitExe remote add origin $remote
    }
    $branch = (& $gitExe branch --show-current)
    if (-not $branch) { $branch = "main" }
    $authRemote = "https://x-access-token:${Token}@github.com/$owner/$($p.name).git"
    & $gitExe push $authRemote "${branch}:${branch}" 2>&1 | ForEach-Object { "    $_" }
    if ($LASTEXITCODE -ne 0) {
      Write-Host "  [!] push failed for $($p.name)" -ForegroundColor Red
      continue
    }
    & $gitExe branch --set-upstream-to="origin/$branch" $branch 2>$null
    Write-Host "  [OK] pushed $branch" -ForegroundColor Green
  } catch {
    Write-Host "  [!] push failed: $($_.Exception.Message)" -ForegroundColor Red
  } finally {
    Pop-Location
  }
}

Write-Host ""
Write-Host "done:" -ForegroundColor Cyan
foreach ($p in $projects) {
  if ($Only -ne "" -and $p.dir -notlike "*$Only*") { continue }
  Write-Host "  https://github.com/$owner/$($p.name)"
}
