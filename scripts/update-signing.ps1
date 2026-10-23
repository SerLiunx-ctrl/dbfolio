# 私钥始终位于仓库外；自动解密仅适用于生成密钥时的 Windows 账户。
function Initialize-UpdateSigning {
    if ($env:TAURI_SIGNING_PRIVATE_KEY) { return $true }
    $signingDirectory = Join-Path $env:USERPROFILE '.dbfolio-signing'
    $keyPath = Join-Path $signingDirectory 'updater.key'
    $passwordPath = Join-Path $signingDirectory 'password.dpapi'
    if (-not (Test-Path -LiteralPath $keyPath) -or -not (Test-Path -LiteralPath $passwordPath)) { return $false }
    # 直接读取 DPAPI 密文，避免 PowerShell 7 / Windows PowerShell 5 模块路径冲突。
    Add-Type -AssemblyName System.Security
    $encryptedHex = [IO.File]::ReadAllText($passwordPath).Trim()
    if ($encryptedHex -notmatch '^[0-9a-fA-F]+$' -or $encryptedHex.Length % 2) { throw '更新密钥密码文件格式无效' }
    $encryptedBytes = New-Object byte[] ($encryptedHex.Length / 2)
    for ($i = 0; $i -lt $encryptedBytes.Length; $i++) { $encryptedBytes[$i] = [Convert]::ToByte($encryptedHex.Substring($i * 2, 2), 16) }
    $passwordBytes = [Security.Cryptography.ProtectedData]::Unprotect($encryptedBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $env:TAURI_SIGNING_PRIVATE_KEY = $keyPath
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [Text.Encoding]::Unicode.GetString($passwordBytes)
    [Array]::Clear($passwordBytes, 0, $passwordBytes.Length)
    return $true
}

function Invoke-UpdateSignature([string]$File) {
    $configuredKey = $env:TAURI_SIGNING_PRIVATE_KEY
    $previousPath = $env:TAURI_SIGNING_PRIVATE_KEY_PATH
    try {
        Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue
        # CLI 的 -k / -f 互斥，环境变量也参与此检查；路径模式暂时清除 -k 的环境值。
        if (Test-Path -LiteralPath $configuredKey -ErrorAction SilentlyContinue) {
            $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $configuredKey
            Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY
        }
        $cli = Join-Path (Split-Path -Parent $PSScriptRoot) 'node_modules/.bin/tauri.cmd'
        & $cli signer sign $File | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "更新文件签名失败：$File" }
    } finally {
        $env:TAURI_SIGNING_PRIVATE_KEY = $configuredKey
        $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $previousPath
    }
}
