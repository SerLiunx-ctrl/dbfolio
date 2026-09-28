param(
    [ValidateSet('release', 'release-fast')][string]$Profile = 'release',
    [switch]$Installer
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
    throw 'Version must be a safe semantic version, for example 1.0.0-alpha.'
}
$hostTarget = (& rustc -vV | Select-String '^host: ').ToString().Substring(6)
if ($LASTEXITCODE -ne 0 -or $hostTarget -ne 'x86_64-pc-windows-msvc') {
    throw 'This packaging script currently supports Windows x64 MSVC only.'
}
if ($Installer -and $Profile -ne 'release') { throw 'Installers must use the release profile.' }

if ($Profile -eq 'release-fast') {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    & cargo build --manifest-path (Join-Path $root 'src-tauri/Cargo.toml') --profile release-fast --features custom-protocol --locked
    if ($LASTEXITCODE -ne 0) { throw 'Rust build failed.' }
} else {
    $buildArgs = @('run', 'tauri', 'build', '--', '--features', 'custom-protocol')
    if ($Installer) { $buildArgs += @('--bundles', 'nsis') } else { $buildArgs += '--no-bundle' }
    $buildArgs += @('--', '--locked')
    & npm @buildArgs
    if ($LASTEXITCODE -ne 0) { throw 'Tauri build failed.' }
}

$releaseDir = Join-Path (Join-Path $root 'release') $version
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
$suffix = if ($Profile -eq 'release-fast') { 'portable-fast' } else { 'portable' }
$baseName = "DBFolio_${version}_windows_x64"
$packageName = "${baseName}_${suffix}"
$packageDir = Join-Path $releaseDir $packageName
$staging = Join-Path $releaseDir ('.staging-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null

function Remove-PackageDirectory([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    $allowed = [IO.Path]::GetFullPath($releaseDir) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a directory outside release: $resolved"
    }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}

try {
    Copy-Item -LiteralPath (Join-Path $root "src-tauri/target/$Profile/dbfolio.exe") -Destination (Join-Path $staging 'DBFolio.exe')
    Copy-Item -LiteralPath (Join-Path $root 'dist') -Destination (Join-Path $staging 'web') -Recurse
    Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination $staging
    @"
DBFolio $version ($Profile) - Windows x64 便携版

请完整解压本目录，再运行 DBFolio.exe。web 目录必须和 EXE 放在一起。
需要 Microsoft Edge WebView2 Runtime；便携包不附带该运行时。
便携版免安装，但会话、首选项和历史仍位于 %APPDATA%\data-workbench；
密码仍由 Windows 凭据管理器保存，不能通过复制程序目录迁移。
更新时先退出 DBFolio，再解压到新目录并整体替换程序文件，勿混用不同版本的 web 目录。
当前尚未提供自动在线更新。此包未做代码签名。
"@ | Set-Content -LiteralPath (Join-Path $staging '使用说明.txt') -Encoding UTF8
    $files = [ordered]@{}
    Get-ChildItem -LiteralPath $staging -File -Recurse | Sort-Object FullName | ForEach-Object {
        $relative = $_.FullName.Substring($staging.Length + 1).Replace('\', '/')
        $files[$relative] = Get-Sha256 $_.FullName
    }
    [ordered]@{ version = $version; target = $hostTarget; profile = $Profile; files = $files } |
        ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $staging 'distribution.json') -Encoding UTF8
    $verificationError = Join-Path $staging '.verification-error.txt'
    $verified = Start-Process -FilePath (Join-Path $staging 'DBFolio.exe') -ArgumentList '--verify-resources' -WorkingDirectory $root -WindowStyle Hidden -Wait -PassThru -RedirectStandardError $verificationError
    $errorText = Get-Content -LiteralPath $verificationError -Raw
    Remove-Item -LiteralPath $verificationError
    if ($verified.ExitCode -ne 0) { throw "Portable resource verification failed (exit $($verified.ExitCode)): $errorText" }
    Remove-PackageDirectory $packageDir
    Move-Item -LiteralPath $staging -Destination $packageDir
    $archive = Join-Path $releaseDir "$packageName.zip"
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
    [IO.Compression.ZipFile]::CreateFromDirectory($packageDir, $archive, [IO.Compression.CompressionLevel]::Optimal, $true)
    $artifacts = @($archive)
    $portableChecksums = @("$(Get-Sha256 $archive)  $([IO.Path]::GetFileName($archive))")
    $portableChecksums += Get-ChildItem -LiteralPath $packageDir -File -Recurse | Sort-Object FullName | ForEach-Object {
        $relative = $_.FullName.Substring($releaseDir.Length + 1).Replace('\', '/')
        "$(Get-Sha256 $_.FullName)  $relative"
    }
    [IO.File]::WriteAllLines((Join-Path $releaseDir "${baseName}_${suffix}_SHA256SUMS.txt"), [string[]]$portableChecksums, [Text.UTF8Encoding]::new($false))
    if ($Installer) {
        $setupSource = Join-Path $root "src-tauri/target/$Profile/bundle/nsis/DBFolio_${version}_x64-setup.exe"
        $setupTarget = Join-Path $releaseDir "${baseName}_setup.exe"
        Copy-Item -LiteralPath $setupSource -Destination $setupTarget -Force
        "$(Get-Sha256 $setupTarget)  $([IO.Path]::GetFileName($setupTarget))" |
            Set-Content -LiteralPath (Join-Path $releaseDir "${baseName}_setup_SHA256SUMS.txt") -Encoding ASCII
        $artifacts += $setupTarget
    }
    Write-Host "Portable directory: $packageDir"
    $artifacts | ForEach-Object { Write-Host "Artifact: $_" }
} finally {
    Remove-PackageDirectory $staging
}
