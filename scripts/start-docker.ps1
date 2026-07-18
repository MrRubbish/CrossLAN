param(
  [int]$Port = 8765,
  [int]$RelayBufferMb = 256,
  [switch]$Foreground
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:PORT = [string]$Port
$env:CROSSLAN_RELAY_BUFFER_MB = [string]$RelayBufferMb

if ($Foreground) {
  docker compose up --build
} else {
  docker compose up -d --build
  Write-Host "CrossLAN Docker service started in the background."
  Write-Host "URL: http://<PC-LAN-IP>:$Port"
  Write-Host 'View logs with: docker compose logs -f crosslan'
}
