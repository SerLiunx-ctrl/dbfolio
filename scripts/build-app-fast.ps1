# Fast iteration build: no LTO, parallel codegen. Output to release\DBFolio.exe
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

Write-Host "==> Building frontend"
npm run build
if ($LASTEXITCODE -ne 0) { throw "frontend build failed" }

Write-Host "==> cargo build --profile release-fast"
Push-Location (Join-Path $root "src-tauri")
try {
    & cargo build --profile release-fast --features custom-protocol
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
} finally {
    Pop-Location
}

$releaseDir = Join-Path $root "release"
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null

$source = Join-Path $root "src-tauri\target\release-fast\dbfolio.exe"
$target = Join-Path $releaseDir "DBFolio.exe"
Copy-Item -LiteralPath $source -Destination $target -Force

Write-Host ""
Write-Host "==> Done. Double-click to run: $target"
