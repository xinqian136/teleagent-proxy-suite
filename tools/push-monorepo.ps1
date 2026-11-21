param(
  [Parameter(Mandatory=$true)][string]$Token,
  [string]$Owner = 'xinqian136',
  [string]$Repo = 'teleagent-proxy-suite',
  [string]$Local = '',
  [switch]$Private
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

if (-not $Local) { $Local = Split-Path -Parent $MyInvocation.MyCommand.Path }
$headers = @{
  Authorization          = "Bearer $Token"
  Accept                 = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
  'User-Agent'           = 'teleagent-proxy-suite-push'
}

function Find-Git {
  $c = Get-Command git -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @(
    "$env:ProgramFiles\Git\cmd\git.exe",
    "${env:ProgramFiles(x86)}\Git\cmd\git.exe",
    "$env:ProgramFiles\Git\bin\git.exe",
    "${env:ProgramFiles(x86)}\Git\bin\git.exe",
    "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe"
  )) { if ($p -and (Test-Path $p)) { return $p } }
  throw 'git.exe not found'
}
$gitExe = Find-Git

function Invoke-GitRaw([string]$Dir, [string]$Arguments) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $gitExe
  $psi.Arguments = $Arguments
  $psi.WorkingDirectory = $Dir
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  try {
    [void]$p.Start()
  } catch {
    Write-Host "  [spawn failed] git $Arguments"
    Write-Host "    $($_.Exception.Message)"
    if ($_.Exception.InnerException) {
      Write-Host "    inner: $($_.Exception.InnerException.GetType().FullName) :: $($_.Exception.InnerException.Message)"
    }
    throw
  }
  $ms = New-Object System.IO.MemoryStream
  $p.StandardOutput.BaseStream.CopyTo($ms)
  $err = $p.StandardError.ReadToEnd()
  $p.WaitForExit()
  if ($p.ExitCode -ne 0) { throw "git $Arguments failed: $err" }
  return ,$ms.ToArray()
}

function Invoke-GitText([string]$Dir, [string]$Arguments) {
  $b = Invoke-GitRaw $Dir $Arguments
  return [Text.Encoding]::UTF8.GetString($b).TrimEnd("`r", "`n")
}

function Invoke-Gh([string]$Method, [string]$Uri, $Body = $null) {
  if ($null -eq $Body) {
    return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $headers -ErrorAction Stop
  }
  $json = $Body | ConvertTo-Json -Depth 30 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $headers -Body $bytes -ContentType 'application/json' -ErrorAction Stop
}

# ---------------------------------------------------------------- 建仓
try {
  Invoke-Gh 'GET' "https://api.github.com/repos/$Owner/$Repo" | Out-Null
  Write-Host "  [=] repo exists: $Owner/$Repo"
} catch {
  $body = @{
    name        = $Repo
    description = 'TeleAgent reverse proxy monorepo - 4 versions with full git history + protocol docs for building your own middleware'
    private    = [bool]$Private
    auto_init  = $false
  }
  Invoke-Gh 'POST' 'https://api.github.com/user/repos' $body | Out-Null
  Write-Host "  [+] created $Owner/$Repo"
}

# 空仓库要先有 main 分支，Git Data API 才接受 blob
try {
  Invoke-Gh 'GET' "https://api.github.com/repos/$Owner/$Repo/git/ref/heads/main" | Out-Null
} catch {
  $body = @{
    message = 'init branch'
    content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('init'))
    branch  = 'main'
  }
  Invoke-Gh 'PUT' "https://api.github.com/repos/$Owner/$Repo/contents/.gitkeep" $body | Out-Null
  Write-Host '  [+] initialized main branch'
}

# ---------------------------------------------------------------- 推分支
$branches = @('main', 'v1', 'v2', 'v3', 'v4')
$blobCache = @{}

foreach ($branch in $branches) {
  Write-Host ''
  Write-Host "=== branch $branch ==="

  $commits = @((Invoke-GitText $Local "rev-list --reverse $branch") -split "`n" | Where-Object { $_ })
  if ($commits.Count -eq 0) { Write-Host "  [!] branch $branch has no commits"; continue }
  Write-Host "  commits: $($commits.Count)"

  $commitMap = @{}

  foreach ($commit in $commits) {
    $treeEntries = @()
    $raw = Invoke-GitRaw $Local "ls-tree -r -z $commit"
    $records = [Text.Encoding]::UTF8.GetString($raw).Split([char]0) | Where-Object { $_ }
    foreach ($rec in $records) {
      $sep = $rec.IndexOf("`t")
      if ($sep -lt 0) { continue }
      $meta = $rec.Substring(0, $sep)
      $path = $rec.Substring($sep + 1)
      $parts = $meta -split ' '
      if ($parts.Count -lt 3) { continue }
      $mode = $parts[0]; $type = $parts[1]; $sha = $parts[2]

      if ($type -eq 'blob') {
        if (-not $blobCache.ContainsKey($sha)) {
          $bytes = Invoke-GitRaw $Local "cat-file blob $sha"
          $b64 = [Convert]::ToBase64String($bytes)
          $res = Invoke-Gh 'POST' "https://api.github.com/repos/$Owner/$Repo/git/blobs" @{
            content  = $b64
            encoding = 'base64'
          }
          $blobCache[$sha] = $res.sha
        }
        $remoteSha = $blobCache[$sha]
      } else {
        $remoteSha = $sha
      }

      $treeEntries += @{ path = $path; mode = $mode; type = $type; sha = $remoteSha }
    }

    $treeRes = Invoke-Gh 'POST' "https://api.github.com/repos/$Owner/$Repo/git/trees" @{ tree = $treeEntries }

    $meta = Invoke-GitText $Local "show -s --format=%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%B $commit"
    $m = $meta -split [char]0x1f
    $message = ($m[6..($m.Count - 1)] -join [char]0x1f)

    $parentLine = Invoke-GitText $Local "rev-list --parents -n 1 $commit"
    $localParents = @($parentLine -split ' ' | Select-Object -Skip 1)
    $remoteParents = @()
    foreach ($lp in $localParents) {
      if ($commitMap.ContainsKey($lp)) { $remoteParents += $commitMap[$lp] }
    }

    $commitRes = Invoke-Gh 'POST' "https://api.github.com/repos/$Owner/$Repo/git/commits" @{
      message   = $message
      tree      = $treeRes.sha
      parents   = $remoteParents
      author    = @{ name = $m[0]; email = $m[1]; date = $m[2] }
      committer = @{ name = $m[3]; email = $m[4]; date = $m[5] }
    }
    $commitMap[$commit] = $commitRes.sha
  }

  $finalSha = $commitMap[$commits[-1]]
  try {
    Invoke-Gh 'GET' "https://api.github.com/repos/$Owner/$Repo/git/ref/heads/$branch" | Out-Null
    Invoke-Gh 'PATCH' "https://api.github.com/repos/$Owner/$Repo/git/refs/heads/$branch" @{ sha = $finalSha; force = $true } | Out-Null
  } catch {
    Invoke-Gh 'POST' "https://api.github.com/repos/$Owner/$Repo/git/refs" @{ ref = "refs/heads/$branch"; sha = $finalSha } | Out-Null
  }
  Write-Host "  [OK] $branch -> $finalSha ($($commitMap.Count) commits)"
}

Write-Host ''
Write-Host "done: https://github.com/$Owner/$Repo"
