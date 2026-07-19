param(
  [int]$Port = 6100,
  [int]$RelayBufferMb = 256,
  [string]$SaveDir = '',
  [string]$AdvertisedIp = ''
)

$ErrorActionPreference = 'Stop'

& (Join-Path $PSScriptRoot 'stop-docker.ps1')
& (Join-Path $PSScriptRoot 'start-docker.ps1') `
  -Port $Port `
  -RelayBufferMb $RelayBufferMb `
  -SaveDir $SaveDir `
  -AdvertisedIp $AdvertisedIp

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
