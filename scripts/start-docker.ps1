param(
  [int]$Port = 8080,
  [int]$RelayBufferMb = 256
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:PORT = [string]$Port
$env:CROSSLAN_RELAY_BUFFER_MB = [string]$RelayBufferMb

docker compose up --build
