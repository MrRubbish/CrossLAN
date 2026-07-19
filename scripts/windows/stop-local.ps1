param(
  [string]$PidFile = "$PSScriptRoot\..\..\logs\crosslan-node.pid"
)

$ErrorActionPreference = 'Stop'
$resolvedPidFile = [System.IO.Path]::GetFullPath($PidFile)

if (-not (Test-Path -LiteralPath $resolvedPidFile)) {
  Write-Host 'CrossLAN Node server is not running.'
  return
}

$serverPid = 0
[int]::TryParse((Get-Content -LiteralPath $resolvedPidFile -Raw).Trim(), [ref]$serverPid) | Out-Null
if ($serverPid -le 0) {
  Remove-Item -LiteralPath $resolvedPidFile -Force -ErrorAction SilentlyContinue
  Write-Host 'Removed stale CrossLAN PID file.'
  return
}

$process = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
if (-not $process) {
  Remove-Item -LiteralPath $resolvedPidFile -Force -ErrorAction SilentlyContinue
  Write-Host 'CrossLAN Node server is not running; removed stale PID file.'
  return
}

Stop-Process -Id $serverPid -Force
try {
  Wait-Process -Id $serverPid -Timeout 10 -ErrorAction SilentlyContinue
} catch {
  # The process may already have exited after Stop-Process.
}

Remove-Item -LiteralPath $resolvedPidFile -Force -ErrorAction SilentlyContinue
Write-Host "Stopped CrossLAN Node server (PID $serverPid)."
