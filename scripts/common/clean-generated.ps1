param(
  [switch]$KeepDesktopTarget
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$rootPrefix = $root.TrimEnd('\') + '\'

$relativeTargets = @(
  'client\dist',
  'desktop\dist',
  '.pkg-cache'
)
if (-not $KeepDesktopTarget) {
  $relativeTargets += 'desktop\src-tauri\target'
}

foreach ($relativeTarget in $relativeTargets) {
  $target = [System.IO.Path]::GetFullPath((Join-Path $root $relativeTarget))
  if (-not $target.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean a path outside the workspace: $target"
  }
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
    Write-Host "Removed $relativeTarget"
  }
}

$sidecarDir = [System.IO.Path]::GetFullPath((Join-Path $root 'desktop\src-tauri\binaries'))
if (-not $sidecarDir.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to clean a path outside the workspace: $sidecarDir"
}
if (Test-Path -LiteralPath $sidecarDir) {
  Get-ChildItem -LiteralPath $sidecarDir -Filter '*.exe' -File -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
  Write-Host 'Removed generated desktop sidecar executables'
}

Write-Host 'Generated build artifacts cleaned. Source files and the installer were not changed.'
