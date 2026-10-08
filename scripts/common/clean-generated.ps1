$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$rootPrefix = $root.TrimEnd('\') + '\'

$relativeTargets = @(
  'client\dist'
)

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

Write-Host 'Generated web build artifacts cleaned. Source files were not changed.'
