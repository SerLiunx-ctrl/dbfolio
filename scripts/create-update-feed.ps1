param([string]$Version, [string]$NotesPath)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/update-signing.ps1"
if (-not (Initialize-UpdateSigning)) { throw '生成更新索引需要仓库外的更新签名私钥。' }
$root = Split-Path -Parent $PSScriptRoot
if (-not $Version) { $Version = (Get-Content -LiteralPath "$root/package.json" -Raw | ConvertFrom-Json).version }
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw '无效的版本号' }
$release = Join-Path "$root/release" $Version
$baseName = "DBFolio_${Version}_windows_x64"
if (-not $NotesPath) {
    $releaseNotes = Join-Path $root "docs/releases/$Version.md"
    if (Test-Path -LiteralPath $releaseNotes) { $NotesPath = $releaseNotes }
}
$notes = if ($NotesPath) { [IO.File]::ReadAllText($NotesPath, [Text.Encoding]::UTF8) } else { "DBFolio $Version，完整改动请查看项目发布说明。" }
$platforms = [ordered]@{}
foreach ($artifact in @(@{ suffix = 'setup.exe'; target = 'windows-x86_64' }, @{ suffix = 'portable.zip'; target = 'windows-x86_64-portable' })) {
    $name = "${baseName}_$($artifact.suffix)"
    $file = Join-Path $release $name
    if (-not (Test-Path -LiteralPath $file)) { throw "缺少正式产物：$name" }
    Invoke-UpdateSignature $file
    $platforms[$artifact.target] = [ordered]@{
        url = "https://github.com/SerLiunx-ctrl/dbfolio/releases/download/v$Version/$name"
        signature = (Get-Content -LiteralPath "$file.sig" -Raw).Trim()
        size = (Get-Item -LiteralPath $file).Length
    }
}
$feed = [ordered]@{ version = $Version; notes = $notes; pub_date = [DateTime]::UtcNow.ToString('o'); platforms = $platforms }
$channel = if ($Version.Contains('-')) { 'preview' } else { 'stable' }
$json = $feed | ConvertTo-Json -Depth 8
$metadataPath = Join-Path $release 'release-metadata.json'
[IO.File]::WriteAllText($metadataPath, $json, [Text.UTF8Encoding]::new($false))
Invoke-UpdateSignature $metadataPath
$feed['signedMetadata'] = [Convert]::ToBase64String([IO.File]::ReadAllBytes($metadataPath))
$feed['metadataSignature'] = (Get-Content -LiteralPath "$metadataPath.sig" -Raw).Trim()
$json = $feed | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText((Join-Path $release "$channel.json"), $json, [Text.UTF8Encoding]::new($false))
Write-Host "已生成签名包与 $channel.json。先上传完整 Release 资产并验证下载，再把此索引发布到 updates/$channel.json。"
