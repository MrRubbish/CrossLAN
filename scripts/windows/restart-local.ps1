param(
  [int]$Port = 6100,
  [string]$SaveDir = "$env:USERPROFILE\Downloads\CrossLAN",
  [int]$RelayBufferMb = 256,
  [string]$AdvertisedIp = '',
  [switch]$Build
)

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'stop-local.ps1')
& (Join-Path $PSScriptRoot 'start-local-background.ps1') `
  -Port $Port `
  -SaveDir $SaveDir `
  -RelayBufferMb $RelayBufferMb `
  -AdvertisedIp $AdvertisedIp `
  -Build:$Build

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Host "CrossLAN Node server restarted on port $Port."
