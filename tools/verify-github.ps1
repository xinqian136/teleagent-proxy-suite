param(
  [Parameter(Mandatory=$true)][string]$Token,
  [string]$Owner = 'xinqian136'
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$headers = @{
  Authorization = "Bearer $Token"
  Accept = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
  'User-Agent' = 'teleagent-proxy-verify'
}
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$gitExe = 'C:\Program Files (x86)\Git\cmd\git.exe'
if (-not (Test-Path $gitExe)) { $gitExe = 'git.exe' }

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
  if ($p.ExitCode -ne 0) { throw "git failed: $err" }
  return ,$ms.ToArray()
}

foreach ($n in @('teleagent-proxy','teleagent-proxy-v2','teleagent-proxy-v3','teleagent-proxy-v4')) {
  $d = Join-Path $root $n
  $head = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$n/commits/main" -Headers $headers
  $tree = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$n/git/trees/$($head.sha)?recursive=1" -Headers $headers
  $remote = @{}
  foreach ($e in $tree.tree) { if ($e.type -eq 'blob') { $remote[$e.path] = $e.sha } }

  $raw = Invoke-GitRaw $d '-c core.quotePath=false ls-tree -r HEAD'
  $text = [Text.Encoding]::UTF8.GetString($raw)
  $local = @{}
  foreach ($line in ($text -split "`n")) {
    if ($line -match '^\d+ blob ([0-9a-f]+)\t(.+)$') {
      $local[$Matches[2].TrimEnd("`r")] = $Matches[1]
    }
  }
  $diff = @()
  foreach ($k in $local.Keys) {
    if (-not $remote.ContainsKey($k) -or $remote[$k] -ne $local[$k]) { $diff += $k }
  }
  foreach ($k in $remote.Keys) {
    if (-not $local.ContainsKey($k)) { $diff += "EXTRA:$k" }
  }
  [pscustomobject]@{
    repo = $n
    local = $local.Count
    remote = $remote.Count
    diff = @($diff).Count
    sample = (@($diff) | Select-Object -First 5) -join ' | '
  }
}
