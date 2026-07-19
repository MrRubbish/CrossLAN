param(
  [switch]$SkipClientBuild
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$desktopRoot = Join-Path $root 'desktop'
$binaryDir = Join-Path $desktopRoot 'src-tauri\binaries'
$binaryPath = Join-Path $binaryDir 'crosslan-server-x86_64-pc-windows-msvc.exe'
$npmPath = (Get-Command npm.cmd -ErrorAction Stop).Source
$pkgPath = Join-Path $root 'node_modules\.bin\pkg.cmd'
$env:PKG_CACHE_PATH = Join-Path $root '.pkg-cache'

Set-Location $root

if (-not $SkipClientBuild) {
  & $npmPath run build
  if ($LASTEXITCODE -ne 0) {
    throw "CrossLAN frontend build failed with exit code $LASTEXITCODE"
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $root 'client\dist\index.html'))) {
  throw 'client/dist/index.html is missing. Build the CrossLAN frontend first.'
}

if (-not (Test-Path -LiteralPath $pkgPath)) {
  throw 'The desktop packager is missing. Run npm install first.'
}

New-Item -ItemType Directory -Force -Path $binaryDir | Out-Null

& $pkgPath `
  (Join-Path $root 'server\package.json') `
  --targets node22-win-x64 `
  --output $binaryPath `
  --compress GZip

if ($LASTEXITCODE -ne 0) {
  throw "CrossLAN server packaging failed with exit code $LASTEXITCODE"
}

Write-Host "Prepared CrossLAN desktop sidecar: $binaryPath"
