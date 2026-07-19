param(
  [string]$TaskName = 'CrossLAN Node',
  [int]$Port = 6100,
  [string]$SaveDir = "$env:USERPROFILE\Downloads\CrossLAN",
  [int]$RelayBufferMb = 256,
  [string]$AdvertisedIp = '',
  [switch]$Build,
  [switch]$StartNow
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$workerScript = Join-Path $PSScriptRoot 'start-local-background.ps1'
$distIndex = Join-Path $root 'client\dist\index.html'

if ($Port -lt 1 -or $Port -gt 65535) {
  throw "Invalid port: $Port"
}
if ($Port -eq 6000) {
  Write-Warning 'Chromium-based browsers block port 6000; use 6100 or another safe port.'
}

if (-not (Test-Path -LiteralPath $workerScript)) {
  throw "Missing startup script: $workerScript"
}

Set-Location $root
if ($Build) {
  npm run build
  if ($LASTEXITCODE -ne 0) {
    throw "npm run build failed with exit code $LASTEXITCODE"
  }
} elseif (-not (Test-Path -LiteralPath $distIndex)) {
  throw 'client/dist/index.html is missing. Run npm run build first, or install with -Build.'
}

$userId = "$env:USERDOMAIN\$env:USERNAME"
$powershellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$quotedWorkerScript = '"' + $workerScript + '"'
$quotedSaveDir = '"' + $SaveDir + '"'
$quotedAdvertisedIp = '"' + $AdvertisedIp + '"'
$actionArguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $quotedWorkerScript -Worker -Port $Port -SaveDir $quotedSaveDir -RelayBufferMb $RelayBufferMb -AdvertisedIp $quotedAdvertisedIp"

$action = New-ScheduledTaskAction `
  -Execute $powershellPath `
  -Argument $actionArguments `
  -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal `
  -UserId $userId `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description 'Start the CrossLAN Node server in the background when the current Windows user logs on.' `
  -Force | Out-Null

Write-Host "Installed Windows logon task: $TaskName"
Write-Host "Node server URL: http://<PC-LAN-IP>:$Port"
Write-Host "Logs: $(Join-Path $root 'logs\crosslan-node.out.log')"

if ($StartNow) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host 'Started the task now.'
}
