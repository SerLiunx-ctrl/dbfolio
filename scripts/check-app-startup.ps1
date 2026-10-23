param(
    [Parameter(Mandatory=$true)][string]$Executable,
    [string]$OutputDirectory,
    [int]$TimeoutSeconds = 45
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskExe = (Get-Item -LiteralPath $Executable).FullName
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path "$taskRoot/.qa" ('startup-' + [guid]::NewGuid().ToString('N'))
}
$taskOutput = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskProfile = Join-Path $taskOutput ('profile-' + [guid]::NewGuid().ToString('N'))
$taskWebview = Join-Path $taskOutput ('webview-' + [guid]::NewGuid().ToString('N'))
if (-not ('DBFolioStartupWindow' -as [type])) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DBFolioStartupWindow {
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
}
'@
}
$taskInfo = New-Object Diagnostics.ProcessStartInfo
$taskInfo.FileName = $taskExe
$taskInfo.WorkingDirectory = Split-Path -Parent $taskExe
$taskInfo.Arguments = '--startup-check "' + $taskProfile + '"'
$taskInfo.UseShellExecute = $false
$taskInfo.CreateNoWindow = $true
$taskInfo.RedirectStandardError = $true
$taskInfo.RedirectStandardOutput = $true
# WebView2 也使用独立缓存，不能共享用户正在运行的窗口配置或网页存储。
$taskInfo.EnvironmentVariables['WEBVIEW2_USER_DATA_FOLDER'] = $taskWebview
$taskProcess = New-Object Diagnostics.Process
$taskProcess.StartInfo = $taskInfo
$taskReady = $null
$taskVisible = $false
$taskFailure = $null
try {
    if (-not $taskProcess.Start()) { throw '无法启动验收进程' }
    $taskErrorRead = $taskProcess.StandardError.ReadToEndAsync()
    $taskOutputRead = $taskProcess.StandardOutput.ReadToEndAsync()
    $taskDeadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $taskDeadline) {
        if ($taskProcess.HasExited) { throw "程序正常启动链路提前退出：$($taskProcess.ExitCode)" }
        $taskProcess.Refresh()
        $taskVisible = $taskProcess.MainWindowHandle -ne [IntPtr]::Zero -and [DBFolioStartupWindow]::IsWindowVisible($taskProcess.MainWindowHandle)
        $taskMarker = Join-Path $taskProfile 'frontend-ready.json'
        if ($taskVisible -and (Test-Path -LiteralPath $taskMarker)) {
            $taskReady = [IO.File]::ReadAllText($taskMarker) | ConvertFrom-Json
            if ($taskReady.pid -ne $taskProcess.Id) { throw '前端就绪进程不匹配' }
            break
        }
        Start-Sleep -Milliseconds 150
    }
    if (-not $taskReady) { throw '启动验收超时：未同时确认可见主窗口与前端 IPC 就绪' }
    if (-not (Test-Path -LiteralPath $taskWebview)) { throw 'WebView2 未创建独立缓存，不能视为隔离验收通过' }
    # 启动成功后继续观察，避免把瞬间出现的窗口误认为可用。
    if ($taskProcess.WaitForExit(2000)) { throw '前端就绪后程序意外退出' }
} catch {
    $taskFailure = $_.Exception.Message
} finally {
    if ($taskProcess.Id -and -not $taskProcess.HasExited) {
        $null = $taskProcess.CloseMainWindow()
        if (-not $taskProcess.WaitForExit(8000)) {
            # 仅结束本脚本创建的隔离验收进程，不按名称终止用户应用。
            $taskProcess.Kill()
            $taskProcess.WaitForExit()
        }
    }
    if ($taskErrorRead) { [IO.File]::WriteAllText((Join-Path $taskOutput 'stderr.txt'), $taskErrorRead.GetAwaiter().GetResult()) }
    if ($taskOutputRead) { [IO.File]::WriteAllText((Join-Path $taskOutput 'stdout.txt'), $taskOutputRead.GetAwaiter().GetResult()) }
}
if ($taskFailure) {
    $taskStderr = [IO.File]::ReadAllText((Join-Path $taskOutput 'stderr.txt'))
    throw "$taskFailure`n$taskStderr`n诊断目录：$taskOutput"
}
$taskResult = [ordered]@{ version=$taskReady.version; executable=$taskExe; visibleWindow=$taskVisible; frontendReady=$true; isolatedProfile=$taskProfile; exitCode=$taskProcess.ExitCode }
[IO.File]::WriteAllText((Join-Path $taskOutput 'result.json'), ($taskResult | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Host "正常启动通过：$($taskReady.version)，主窗口可见，前端 IPC 就绪；记录 $taskOutput"
