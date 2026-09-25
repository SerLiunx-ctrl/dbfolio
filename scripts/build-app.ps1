# Build portable DBFolio.exe into release\ folder
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

Write-Host "==> Building frontend + Rust release (first run is slow, later runs are incremental)"
npm run tauri build -- --no-bundle
if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }

$releaseDir = Join-Path $root "release"
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null

$source = Join-Path $root "src-tauri\target\release\dbfolio.exe"
$target = Join-Path $releaseDir "DBFolio.exe"
Copy-Item -LiteralPath $source -Destination $target -Force

Write-Host ""
Write-Host "==> Done. Double-click to run: $target"
