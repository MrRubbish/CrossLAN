param(
  [int]$Port = 6100,
  [string]$SaveDir = "$env:USERPROFILE\Downloads\CrossLAN",
  [int]$RelayBufferMb = 256,
  [string]$AdvertisedIp = ''
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Set-Location $root

if ($Port -lt 1 -or $Port -gt 65535) {
  throw "Invalid port: $Port"
}
if ($Port -eq 6000) {
  Write-Warning 'Chromium-based browsers block port 6000; use 6100 or another safe port.'
}

$env:PORT = [string]$Port
$env:CROSSLAN_SAVE_DIR = $SaveDir
$env:CROSSLAN_RELAY_BUFFER_MB = [string]$RelayBufferMb
if ($AdvertisedIp) {
  $env:CROSSLAN_ADVERTISED_IP = $AdvertisedIp
} else {
  Remove-Item Env:CROSSLAN_ADVERTISED_IP -ErrorAction SilentlyContinue
}

npm run build
npm start
