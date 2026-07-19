param(
  [int]$Port = 6100,
  [string]$SaveDir = "$env:USERPROFILE\Downloads\CrossLAN",
  [int]$RelayBufferMb = 256,
  [string]$AdvertisedIp = '',
  [switch]$Build,
  [switch]$Worker
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$logDir = Join-Path $root 'logs'
$stdoutPath = Join-Path $logDir 'crosslan-node.out.log'
$stderrPath = Join-Path $logDir 'crosslan-node.err.log'
$pidPath = Join-Path $logDir 'crosslan-node.pid'
$serviceLogPath = Join-Path $logDir 'crosslan-server.log'
$serverEntry = Join-Path $root 'server\src\index.js'

function Write-LogLine {
  param(
    [string]$Path,
    [string]$Message
  )

  Add-Content -LiteralPath $Path -Encoding UTF8 -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if ($Port -lt 1 -or $Port -gt 65535) {
  throw "Invalid port: $Port"
}
if ($Port -eq 6000) {
  Write-Warning 'Chromium-based browsers block port 6000; use 6100 or another safe port.'
}

if (-not $Worker) {
  if (Test-Path -LiteralPath $pidPath) {
    $existingPid = 0
    [int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$existingPid) | Out-Null
    if ($existingPid -gt 0 -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
      Write-Host "CrossLAN Node server is already running (PID $existingPid)."
      Write-Host "URL: http://<PC-LAN-IP>:$Port"
      exit 0
    }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
  }

  if (-not $Build -and -not (Test-Path -LiteralPath (Join-Path $root 'client\dist\index.html'))) {
    throw 'client/dist/index.html is missing. Run npm run build first, or use -Build.'
  }

  $powershellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
  $quotedScriptPath = '"' + $PSCommandPath + '"'
  $quotedSaveDir = '"' + $SaveDir + '"'
  $quotedAdvertisedIp = '"' + $AdvertisedIp + '"'
  $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $quotedScriptPath -Worker -Port $Port -SaveDir $quotedSaveDir -RelayBufferMb $RelayBufferMb -AdvertisedIp $quotedAdvertisedIp"
  if ($Build) {
    $arguments += ' -Build'
  }

  $process = Start-Process `
    -FilePath $powershellPath `
    -ArgumentList $arguments `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -PassThru

  Write-Host "CrossLAN Node server started in the background (PowerShell PID $($process.Id))."
  Write-Host "URL: http://<PC-LAN-IP>:$Port"
  Write-Host "Logs: $stdoutPath and $stderrPath"
  exit 0
}

Set-Location $root
$env:PORT = [string]$Port
$env:CROSSLAN_SAVE_DIR = $SaveDir
$env:CROSSLAN_RELAY_BUFFER_MB = [string]$RelayBufferMb
$env:CROSSLAN_LOG_FILE = $serviceLogPath
if ($AdvertisedIp) {
  $env:CROSSLAN_ADVERTISED_IP = $AdvertisedIp
} else {
  Remove-Item Env:CROSSLAN_ADVERTISED_IP -ErrorAction SilentlyContinue
}

if ($Build) {
  $npmPath = (Get-Command npm.cmd -ErrorAction Stop).Source
  Write-LogLine -Path $stdoutPath -Message "Background build started: port=$Port saveDir=$SaveDir relayBufferMb=$RelayBufferMb"
  & $npmPath run build 1>> $stdoutPath 2>> $stderrPath
  if ($LASTEXITCODE -ne 0) {
    Write-LogLine -Path $stderrPath -Message "Background build failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $root 'client\dist\index.html'))) {
  Write-LogLine -Path $stderrPath -Message 'client/dist/index.html is missing. Run npm run build before starting CrossLAN.'
  exit 2
}

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
Write-LogLine -Path $stdoutPath -Message "Node server starting: port=$Port saveDir=$SaveDir relayBufferMb=$RelayBufferMb"
$nodeProcess = Start-Process `
  -FilePath $nodePath `
  -ArgumentList @($serverEntry) `
  -WorkingDirectory $root `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -PassThru
Set-Content -LiteralPath $pidPath -Encoding ASCII -Value $nodeProcess.Id

try {
  $nodeProcess.WaitForExit()
  $exitCode = $nodeProcess.ExitCode
} finally {
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}

Write-LogLine -Path $stdoutPath -Message "Node server exited with code $exitCode"
exit $exitCode
