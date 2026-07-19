param(
  [switch]$RemoveVolumes
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Set-Location $root

if ($RemoveVolumes) {
  docker compose down --volumes
} else {
  docker compose down
}
