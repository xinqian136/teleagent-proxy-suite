param(
  [Parameter(Mandatory=$true)][string]$Token,
  [string]$Owner = "xinqian136",
  [string]$Only = ""
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$headers = @{
  Authorization        = "Bearer $Token"
  Accept               = "application/vnd.github+json"
  'X-GitHub-Api-Version' = '2022-11-28'
  'User-Agent'         = 'teleagent-proxy-api-push'
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
  throw "git.exe not found"
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
  [void]$p.Start()
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

function Ensure-Repo([string]$Name, [string]$Desc) {
  try {
    Invoke-Gh 'GET' "https://api.github.com/repos/$Owner/$Name" | Out-Null
    Write-Host "  [=] repo exists: $Owner/$Name"
  } catch {
    $body = @{ name = $Name; description = $Desc; private = $false; auto_init = $false }
    Invoke-Gh 'POST' 'https://api.github.com/user/repos' $body | Out-Null
    Write-Host "  [+] created $Owner/$Name"
  }
  # Empty repos reject Git Data API blobs; create an initial branch first.
  try {
    Invoke-Gh 'GET' "https://api.github.com/repos/$Owner/$Name/git/ref/heads/main" | Out-Null
  } catch {
    $body = @{
      message = 'init branch'
      content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('init'))
      branch  = 'main'
    }
    Invoke-Gh 'PUT' "https://api.github.com/repos/$Owner/$Name/contents/.gitkeep" $body | Out-Null
    Write-Host "  [+] initialized main branch"
  }
}

$projects = @(
  @{ dir = 'teleagent-proxy';    name = 'teleagent-proxy';    desc = 'TeleAgent reverse proxy v1 - direct gateway / app-process modes, OpenAI + Anthropic compatible API' },
  @{ dir = 'teleagent-proxy-v2'; name = 'teleagent-proxy-v2'; desc = 'TeleAgent reverse proxy v2 - CLI version' },
  @{ dir = 'teleagent-proxy-v3'; name = 'teleagent-proxy-v3'; desc = 'TeleAgent reverse proxy v3 - web admin console' },
  @{ dir = 'teleagent-proxy-v4'; name = 'teleagent-proxy-v4'; desc = 'TeleAgent reverse proxy v4 - web console + vision auto-fallback + chat-flagshipAuto alias' }
)

foreach ($p in $projects) {
  if ($Only -ne '' -and $p.dir -notlike "*$Only*") { continue }
  $dir = Join-Path $root $p.dir
  if (-not (Test-Path $dir)) { Write-Host "skip $($p.dir) (not found)"; continue }

  Write-Host ""
  Write-Host "=== $($p.dir) ==="
  Ensure-Repo $p.name $p.desc

  $commits = @((Invoke-GitText $dir 'rev-list --reverse HEAD') -split "`n" | Where-Object { $_ })
  if ($commits.Count -eq 0) { throw "$($p.dir) has no commits" }
  Write-Host "  commits: $($commits.Count)"

  $blobMap = @{}
  $commitMap = @{}

  foreach ($commit in $commits) {
    $treeEntries = @()
    $raw = Invoke-GitRaw $dir "ls-tree -r -z $commit"
    $records = [Text.Encoding]::UTF8.GetString($raw).Split([char]0) | Where-Object { $_ }
    foreach ($rec in $records) {
      $sep = $rec.IndexOf("`t")
      if ($sep -lt 0) { continue }
      $meta = $rec.Substring(0, $sep)
      $path = $rec.Substring($sep + 1)
      $parts = $meta -split ' '
      if ($parts.Count -lt 3) { continue }
      $mode = $parts[0]
      $type = $parts[1]
      $sha  = $parts[2]

      if ($type -eq 'blob') {
        if (-not $blobMap.ContainsKey($sha)) {
          $bytes = Invoke-GitRaw $dir "cat-file blob $sha"
          $b64 = [Convert]::ToBase64String($bytes)
          $res = Invoke-Gh 'POST' "https://api.github.com/repos/$Owner/$($p.name)/git/blobs" @{
            content = $b64
            encoding = 'base64'
          }
          $blobMap[$sha] = $res.sha
        }
        $remoteSha = $blobMap[$sha]
      } else {
        $remoteSha = $sha
      }

      $treeEntries += @{
        path = $path
        mode = $mode
        type = $type
        sha  = $remoteSha
      }
    }

    $treeRes = Invoke-Gh 'POST' "https://api.github.com/repos/$Owner/$($p.name)/git/trees" @{ tree = $treeEntries }

    $meta = Invoke-GitText $dir "show -s --format=%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%B $commit"
    $m = $meta -split [char]0x1f
    $message = ($m[6..($m.Count - 1)] -join [char]0x1f)

    $parentLine = Invoke-GitText $dir "rev-list --parents -n 1 $commit"
    $localParents = @($parentLine -split ' ' | Select-Object -Skip 1)
    $remoteParents = @()
    foreach ($lp in $localParents) {
      if ($commitMap.ContainsKey($lp)) { $remoteParents += $commitMap[$lp] }
    }

    $commitRes = Invoke-Gh 'POST' "https://api.github.com/repos/$Owner/$($p.name)/git/commits" @{
      message  = $message
      tree     = $treeRes.sha
      parents  = $remoteParents
      author   = @{ name = $m[0]; email = $m[1]; date = $m[2] }
      committer= @{ name = $m[3]; email = $m[4]; date = $m[5] }
    }
    $commitMap[$commit] = $commitRes.sha
  }

  $finalSha = $commitMap[$commits[-1]]
  try {
    Invoke-Gh 'GET' "https://api.github.com/repos/$Owner/$($p.name)/git/ref/heads/main" | Out-Null
    Invoke-Gh 'PATCH' "https://api.github.com/repos/$Owner/$($p.name)/git/refs/heads/main" @{ sha = $finalSha; force = $true } | Out-Null
  } catch {
    Invoke-Gh 'POST' "https://api.github.com/repos/$Owner/$($p.name)/git/refs" @{ ref = 'refs/heads/main'; sha = $finalSha } | Out-Null
  }

  Write-Host "  [OK] pushed $($commitMap.Count) commits to https://github.com/$Owner/$($p.name)"
}

Write-Host ""
Write-Host "done"
