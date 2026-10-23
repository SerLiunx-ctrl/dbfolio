param([string]$Version)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
if(-not $Version){$Version=(Get-Content -LiteralPath "$root/package.json" -Raw|ConvertFrom-Json).version}
if($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$'){throw '版本号无效'}
$release=[IO.Path]::GetFullPath((Join-Path "$root/release" $Version))
$prefix="DBFolio_${Version}_windows_x64"
$portable=Join-Path $release "${prefix}_portable"
$checks=0
foreach($suffix in @('setup','portable')){
 foreach($line in Get-Content -LiteralPath (Join-Path $release "${prefix}_${suffix}_SHA256SUMS.txt") -Encoding UTF8){
  if($line -notmatch '^([0-9a-fA-F]{64})\s+(.+)$'){throw '校验清单格式无效'}
  $hash=$Matches[1];$file=[IO.Path]::GetFullPath((Join-Path $release $Matches[2]))
  if(-not $file.StartsWith($release+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw '校验路径越界'}
  if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $hash){throw "校验失败：$file"};$checks++
 }
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead((Join-Path $release "${prefix}_portable.zip"))
$entries=0
try{
 foreach($entry in $zip.Entries){
  if(-not $entry.Name){continue}
  $file=[IO.Path]::GetFullPath((Join-Path $release $entry.FullName.Replace('\','/')))
  if(-not $file.StartsWith($portable+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'ZIP 路径越界'}
  $stream=$entry.Open();$algorithm=[Security.Cryptography.SHA256]::Create()
  try{$hash=([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-','')}finally{$stream.Dispose();$algorithm.Dispose()}
  if($hash -ne (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash){throw "ZIP 与目录内容不一致：$file"};$entries++
 }
}finally{$zip.Dispose()}
$extract=Join-Path "$root/.qa" ('updater-installer-'+[guid]::NewGuid().ToString('N'))
& 'C:/Program Files/7-Zip/7z.exe' x (Join-Path $release "${prefix}_setup.exe") "-o$extract" -y | Out-Null
if($LASTEXITCODE -ne 0){throw 'NSIS 解包失败'}
$resources=0
foreach($file in Get-ChildItem -LiteralPath (Join-Path $portable 'web') -File -Recurse){
 $relative=$file.FullName.Substring((Join-Path $portable 'web').Length+1)
 if((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath (Join-Path "$extract/web" $relative) -Algorithm SHA256).Hash){throw "安装版与便携版资源不一致：$relative"};$resources++
}
foreach($directory in @($portable,$extract)){
 $verified=Start-Process -FilePath (Join-Path $directory 'dbfolio.exe') -ArgumentList '--verify-resources' -WindowStyle Hidden -Wait -PassThru
 if($verified.ExitCode -ne 0){throw "真实 EXE 资源自检失败：$directory"}
 & "$PSScriptRoot/check-app-startup.ps1" -Executable (Join-Path $directory 'dbfolio.exe')
}
$env:DBFOLIO_UPDATE_RELEASE=$release
& cargo test --manifest-path "$root/src-tauri/Cargo.toml" --lib signed_release_roundtrip --locked -- --ignored --nocapture
if($LASTEXITCODE -ne 0){throw '真实签名产物验收失败'}
$result=[ordered]@{version=$Version;checksums=$checks;zipFiles=$entries;installerResources=$resources;resourceChecks='安装版与便携版真实 EXE 通过';startupChecks='便携版与 NSIS 解包 EXE 正常启动、可见窗口和前端 IPC 就绪通过';signatureChecks='安装包、ZIP、索引元数据通过；篡改拒绝';installerUpgrade='未执行隔离安装升级';publicFeed='尚未发布'}
$result|ConvertTo-Json|Set-Content -LiteralPath "$root/.qa/updater-release-verification.json" -Encoding UTF8
$result|ConvertTo-Json
