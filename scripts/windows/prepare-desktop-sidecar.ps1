param(
  [switch]$SkipClientBuild
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$desktopRoot = Join-Path $root 'desktop'
$buildRoot = Join-Path $desktopRoot 'build'
$binaryDir = Join-Path $desktopRoot 'src-tauri\binaries'
$binaryPath = Join-Path $binaryDir 'crosslan-server-x86_64-pc-windows-msvc.exe'
$bundlePath = Join-Path $buildRoot 'server.cjs'
$blobPath = Join-Path $buildRoot 'server.blob'
$seaConfigPath = Join-Path $buildRoot 'sea-config.json'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$esbuildPath = Join-Path $root 'node_modules\.bin\esbuild.cmd'
$postjectPath = Join-Path $root 'node_modules\postject\dist\cli.js'
$clientIndex = Join-Path $root 'client\dist\index.html'
$serverEntry = Join-Path $root 'server\src\index.js'

Set-Location $root

if (-not (Test-Path -LiteralPath $esbuildPath)) {
  throw 'The desktop packager is missing esbuild. Run npm install first.'
}
if (-not (Test-Path -LiteralPath $postjectPath)) {
  throw 'The desktop packager is missing postject. Run npm install first.'
}
if (-not (Test-Path -LiteralPath $serverEntry)) {
  throw "The CrossLAN server entry point is missing: $serverEntry"
}

$nodeVersion = (& $nodePath --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.') {
  throw "Unable to determine the Node.js version from $nodePath."
}
if ([int]$Matches[1] -lt 20) {
  throw "Node.js 20 or newer is required for the SEA sidecar. Found $nodeVersion."
}

if (-not $SkipClientBuild) {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) {
    throw "CrossLAN frontend build failed with exit code $LASTEXITCODE"
  }
}

if (-not (Test-Path -LiteralPath $clientIndex)) {
  throw 'client/dist/index.html is missing. Build the CrossLAN frontend first.'
}

New-Item -ItemType Directory -Force -Path $buildRoot, $binaryDir | Out-Null

& $esbuildPath `
  $serverEntry `
  --bundle `
  --platform=node `
  --format=cjs `
  --outfile=$bundlePath

if ($LASTEXITCODE -ne 0) {
  throw "CrossLAN server bundle failed with exit code $LASTEXITCODE"
}

$seaConfig = [ordered]@{
  main = $bundlePath
  output = $blobPath
  disableExperimentalSEAWarning = $true
  useSnapshot = $false
  useCodeCache = $false
}

try {
  $seaConfig | ConvertTo-Json | Set-Content -LiteralPath $seaConfigPath -Encoding UTF8
  & $nodePath --experimental-sea-config $seaConfigPath
  if ($LASTEXITCODE -ne 0) {
    throw "Node SEA blob generation failed with exit code $LASTEXITCODE"
  }

  if (-not (Test-Path -LiteralPath $blobPath)) {
    throw "Node SEA blob was not generated: $blobPath"
  }

  Copy-Item -LiteralPath $nodePath -Destination $binaryPath -Force
  & $nodePath $postjectPath `
    $binaryPath `
    NODE_SEA_BLOB `
    $blobPath `
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 `
    --overwrite

  if ($LASTEXITCODE -ne 0) {
    throw "Node SEA injection failed with exit code $LASTEXITCODE"
  }
}
finally {
  Remove-Item -LiteralPath $seaConfigPath -Force -ErrorAction SilentlyContinue
}

$binary = Get-Item -LiteralPath $binaryPath
if ($binary.Length -le 0) {
  throw "The generated sidecar is empty: $binaryPath"
}

Write-Host "Prepared CrossLAN desktop sidecar: $binaryPath"
