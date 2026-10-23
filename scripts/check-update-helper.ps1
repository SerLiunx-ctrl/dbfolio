$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. "$PSScriptRoot/update-signing.ps1"
if(-not(Initialize-UpdateSigning)){throw '独立更新验收需要签名私钥'}
$fixture=Join-Path $root ('.qa/updater-probe-'+[guid]::NewGuid().ToString('N'))
$package=Join-Path $fixture 'DBFolio_0.0.0_windows_x64_portable'
New-Item -ItemType Directory -Path (Join-Path $package 'web') -Force | Out-Null
& rustc "$PSScriptRoot/fixtures/update-probe.rs" -o (Join-Path $package 'DBFolio.exe')
if($LASTEXITCODE -ne 0){throw '验收探针编译失败'}
[IO.File]::WriteAllText((Join-Path $package 'web/index.html'),'<html>隔离验收探针</html>')
$files=[ordered]@{}
foreach($file in Get-ChildItem -LiteralPath $package -File -Recurse){$files[$file.FullName.Substring($package.Length+1).Replace('\','/')]=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
$manifest=[ordered]@{version='0.0.0';target='x86_64-pc-windows-msvc';profile='release';kind='portable';files=$files}|ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $package 'distribution.json'),$manifest,[Text.UTF8Encoding]::new($false))
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=Join-Path $fixture 'probe.zip'
[IO.Compression.ZipFile]::CreateFromDirectory($package,$zip,[IO.Compression.CompressionLevel]::Optimal,$true)
Invoke-UpdateSignature $zip
$env:DBFOLIO_UPDATE_FIXTURE=$fixture
& cargo test --manifest-path "$root/src-tauri/Cargo.toml" update_package::tests::signed_helper_lifecycle --locked -- --ignored --nocapture
if($LASTEXITCODE -ne 0){throw '独立进程更新验收失败'}
Write-Host '独立进程升级、启动前失败回退、数据打开后失败保留均通过；未访问用户数据库。'
