param(
  [int]$Port = 6100,
  [int]$RelayBufferMb = 256,
  [string]$AdvertisedIp = '',
  [switch]$Foreground
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
$env:CROSSLAN_RELAY_BUFFER_MB = [string]$RelayBufferMb
$env:CROSSLAN_ADVERTISED_IP = $AdvertisedIp

if ($Foreground) {
  docker compose up --build
} else {
  docker compose up -d --build
  Write-Host "CrossLAN Docker service started in the background."
  Write-Host "URL: http://<PC-LAN-IP>:$Port"
  if ($AdvertisedIp) {
    Write-Host "Advertised service IP: $AdvertisedIp"
  } else {
    Write-Host "Advertised service IP: derived from the URL; set -AdvertisedIp when opening localhost or using multiple adapters."
  }
  Write-Host 'View logs with: docker compose logs -f crosslan'
}
