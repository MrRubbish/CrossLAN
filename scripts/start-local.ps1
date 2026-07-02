param(
  [int]$Port = 8080,
  [string]$SaveDir = "$env:USERPROFILE\Downloads\CrossLAN",
  [int]$RelayBufferMb = 256
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:PORT = [string]$Port
$env:CROSSLAN_SAVE_DIR = $SaveDir
$env:CROSSLAN_RELAY_BUFFER_MB = [string]$RelayBufferMb

npm run build
npm start
