param([Parameter(Mandatory)][string]$Version)

$ErrorActionPreference = 'Stop'
$repo = 'SerLiunx-ctrl/dbfolio'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
if ($Version -cnotmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$') { throw '无效版本号。' }
if ((Get-Content package.json -Raw | ConvertFrom-Json).version -cne $Version) { throw '源码版本与待发版本不一致。' }
$tag = "v$Version"
$prerelease = $Version.Contains('-')
$channel = if ($prerelease) { 'preview' } else { 'stable' }
$indexPath = "updates/$channel.json"
$prefix = "DBFolio_${Version}_windows_x64"
$setup = "${prefix}_setup.exe"
$portable = "${prefix}_portable.zip"
$assets = @($setup, "$setup.sig", "${prefix}_setup_SHA256SUMS.txt",
    $portable, "$portable.sig", "${prefix}_portable_SHA256SUMS.txt",
    'release-metadata.json', 'release-metadata.json.sig')

function Invoke-Gh {
    & gh @args
    if ($LASTEXITCODE -ne 0) { throw "GitHub CLI 失败，退出码 $LASTEXITCODE。" }
}

function Get-Release {
    Invoke-Gh release view $tag --repo $repo --json 'tagName,targetCommitish,body,isDraft,isPrerelease,assets' | ConvertFrom-Json
}

function Get-TagCommit {
    $direct = "refs/tags/$tag"
    $refs = @(git ls-remote origin $direct "$direct^{}")
    if ($LASTEXITCODE -ne 0) { throw '无法检查远端标签。' }
    if ($refs.Count) { return ($refs[-1] -split '\s+')[0] }
}

$release = Get-Release
$source = [string]$release.targetCommitish
if ($release.tagName -cne $tag -or [bool]$release.isPrerelease -ne $prerelease -or $source -cnotmatch '^[a-f0-9]{40}$') {
    throw 'Release 必须使用预期标签、发布类型和完整源码提交 SHA。'
}
git merge-base --is-ancestor $source HEAD
if ($LASTEXITCODE -ne 0) { throw '发版目标必须是当前 master 历史中的提交。' }
$sourceVersion = (git show "${source}:package.json" | ConvertFrom-Json).version
if ($LASTEXITCODE -ne 0 -or $sourceVersion -cne $Version) { throw '标签目标的源码版本与待发布版本不一致。' }
$tagCommit = Get-TagCommit
if (($tagCommit -and $tagCommit -cne $source) -or (!$release.isDraft -and !$tagCommit)) {
    throw '远端标签与 Release 目标提交不一致。'
}
if (@($release.assets).Count -ne $assets.Count) { throw 'Release 资产清单与预期不一致。' }
foreach ($name in $assets) {
    if (@($release.assets | Where-Object { $_.name -ceq $name -and $_.size -gt 0 }).Count -ne 1) { throw "缺少 Release 资产 $name。" }
}

$staging = Join-Path $root ('.qa/release-publish-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging -Force | Out-Null
Invoke-Gh release download $tag --repo $repo --dir $staging
$metadataPath = Join-Path $staging 'release-metadata.json'
$metadata = [IO.File]::ReadAllText($metadataPath, [Text.Encoding]::UTF8) | ConvertFrom-Json -AsHashtable -DateKind String
if ($metadata.version -cne $Version -or ([string]$metadata.notes).TrimEnd() -cne ([string]$release.body).TrimEnd()) {
    throw '签名更新说明与 Release 正文或版本号不一致。'
}

$sha256 = @{}
foreach ($name in $assets) {
    $file = Get-Item -LiteralPath (Join-Path $staging $name)
    $remote = $release.assets | Where-Object name -CEQ $name
    if ($file.Length -ne $remote.size) { throw "文件大小不一致：$name。" }
    $sha256[$name] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
}
foreach ($package in @(
    @{ name = $setup; target = 'windows-x86_64'; sums = "${prefix}_setup_SHA256SUMS.txt" },
    @{ name = $portable; target = 'windows-x86_64-portable'; sums = "${prefix}_portable_SHA256SUMS.txt" }
)) {
    $name = $package.name
    $platform = $metadata.platforms[$package.target]
    $signature = [IO.File]::ReadAllText((Join-Path $staging "$name.sig")).Trim()
    $url = "https://github.com/$repo/releases/download/$tag/$name"
    $length = (Get-Item -LiteralPath (Join-Path $staging $name)).Length
    if ($platform.url -cne $url -or $platform.signature -cne $signature -or $platform.size -ne $length) {
        throw "签名元数据与包不一致：$name。"
    }
    $line = @(Get-Content -LiteralPath (Join-Path $staging $package.sums) |
        Where-Object { $_ -match ('^[0-9a-fA-F]{64}  ' + [regex]::Escape($name) + '$') })
    if ($line.Count -ne 1 -or ($line[0] -split '  ', 2)[0] -ne $sha256[$name]) { throw "SHA256 校验失败：$name。" }
}
if ($metadata.platforms.Count -ne 2) { throw 'Windows 索引包含未经验证的平台。' }
$metadata.signedMetadata = [Convert]::ToBase64String([IO.File]::ReadAllBytes($metadataPath))
$metadata.metadataSignature = [IO.File]::ReadAllText("$metadataPath.sig").Trim()
$index = Join-Path $staging "$channel.json"
[IO.File]::WriteAllText($index, ($metadata | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
$env:DBFOLIO_UPDATE_RELEASE = $staging
try {
    cargo test --manifest-path src-tauri/Cargo.toml --lib signed_release_roundtrip --locked -- --ignored --nocapture
    if ($LASTEXITCODE -ne 0) { throw '更新密钥验签或便携版资源检查失败。' }
} finally {
    Remove-Item Env:DBFOLIO_UPDATE_RELEASE -ErrorAction SilentlyContinue
}

# Files API uses the current blob SHA to reject concurrent changes to the index.
$branch = 'master'
$indexEndpoint = "repos/$repo/contents/$indexPath"
$tip = Invoke-Gh api "repos/$repo/git/ref/heads/$branch" --jq '.object.sha'
$tree = Invoke-Gh api "repos/$repo/git/trees/${tip}?recursive=1" | ConvertFrom-Json
if ($tree.truncated) { throw '无法完整读取现有更新索引状态。' }
$current = $null
if ($tree.tree.path -ccontains $indexPath) {
    $current = Invoke-Gh api "${indexEndpoint}?ref=$branch" | ConvertFrom-Json
    $previous = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($current.content)) | ConvertFrom-Json
    if ([semver]$previous.version -gt [semver]$Version) { throw '线上已存在更新版本，停止发布旧索引。' }
    if ($previous.version -ceq $Version -and $previous.signedMetadata -cne $metadata.signedMetadata) {
        throw '同版本已存在不同的在线更新索引。'
    }
}

if ($release.isDraft) { Invoke-Gh release edit $tag --repo $repo --draft=false }
if ((Get-TagCommit) -cne $source) { throw '公开标签未指向验证过的提交，停止更新索引。' }
$published = Get-Release
if ($published.isDraft -or $published.body -cne $release.body -or @($published.assets).Count -ne $assets.Count) {
    throw '公开发布状态、正文或资产清单异常。'
}

# Public requests do not carry GitHub credentials.
foreach ($name in $assets) {
    $publicFile = Join-Path $staging "public-$name"
    $url = "https://github.com/$repo/releases/download/$tag/$name"
    curl.exe --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --retry 3 --retry-all-errors --max-time 180 --output $publicFile $url
    if ($LASTEXITCODE -ne 0 -or (Get-FileHash -LiteralPath $publicFile -Algorithm SHA256).Hash -ne $sha256[$name]) {
        throw "公开下载或校验失败：$name。可以重跑发布工作流。"
    }
}

if ($null -eq $current -or $previous.version -cne $Version) {
    $request = @{
        message = "chore: 发布 $Version 更新索引"
        branch = $branch
        content = [Convert]::ToBase64String([IO.File]::ReadAllBytes($index))
    }
    if ($current) { $request.sha = $current.sha }
    $requestFile = Join-Path $staging 'index-request.json'
    $request | ConvertTo-Json | Set-Content -LiteralPath $requestFile -Encoding utf8
    Invoke-Gh api --method PUT $indexEndpoint --input $requestFile --jq '.commit.html_url'
}
Write-Host "已验证 $($assets.Count) 项公开下载及签名，更新索引：$indexPath"
