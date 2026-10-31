param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskOutput=Join-Path "$taskRoot/.qa" ('renderer-failure-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskOutput | Out-Null
$taskProfile=Join-Path $taskOutput 'profile'
$taskWebview=Join-Path $taskOutput 'webview'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DBFolioRecoveryProbe {
 public delegate bool EnumProc(IntPtr w,IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback,IntPtr parameter);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr w,System.Text.StringBuilder s,int n);
 public static IntPtr FindDialog(uint target) {IntPtr found=IntPtr.Zero;EnumWindows((w,p)=>{uint pid;GetWindowThreadProcessId(w,out pid);if(pid==target){var cls=new System.Text.StringBuilder(128);GetClassName(w,cls,128);if(cls.ToString()=="#32770"){found=w;return false;}}return true;},IntPtr.Zero);return found;}
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls,string title);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle,out uint process);
}
'@
$taskInfo=New-Object Diagnostics.ProcessStartInfo
$taskInfo.FileName=(Get-Item -LiteralPath $Executable).FullName
$taskInfo.WorkingDirectory=Split-Path -Parent $taskInfo.FileName
$taskInfo.Arguments='--startup-check "'+$taskProfile+'"'
$taskInfo.UseShellExecute=$false
$taskInfo.CreateNoWindow=$true
$taskInfo.RedirectStandardError=$true
$taskInfo.RedirectStandardOutput=$true
$taskInfo.EnvironmentVariables['WEBVIEW2_USER_DATA_FOLDER']=$taskWebview
$taskProcess=New-Object Diagnostics.Process
$taskProcess.StartInfo=$taskInfo
try{
 if(-not $taskProcess.Start()){throw '无法启动隔离进程'}
 $taskErr=$taskProcess.StandardError.ReadToEndAsync();$taskOut=$taskProcess.StandardOutput.ReadToEndAsync()
 $deadline=[DateTime]::UtcNow.AddSeconds(60)
 $marker=Join-Path $taskProfile 'frontend-ready.json'
 while(-not(Test-Path -LiteralPath $marker)){
  if($taskProcess.HasExited -or [DateTime]::UtcNow -gt $deadline){throw '隔离实例未就绪'}
  Start-Sleep -Milliseconds 150
 }
 $ready=Get-Content -LiteralPath $marker -Raw|ConvertFrom-Json
 if($ready.pid -ne $taskProcess.Id){throw '就绪进程不匹配'}
 $readyTime=(Get-Item -LiteralPath $marker).LastWriteTimeUtc
 $processes=@(Get-CimInstance Win32_Process)
 $owned=@($taskProcess.Id)
 do{$previous=$owned.Count;$owned+=@($processes|Where-Object {$_.ParentProcessId -in $owned -and $_.ProcessId -notin $owned}|ForEach-Object {[int]$_.ProcessId})}while($owned.Count -gt $previous)
 $renderer=$processes|Where-Object {$_.ProcessId -in $owned -and $_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -match '--type=renderer'}|Select-Object -First 1
 if(-not $renderer){throw '找不到本隔离实例的渲染进程'}
 $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($renderer.ProcessId)"
 if($current.ParentProcessId -ne $renderer.ParentProcessId -or $current.CreationDate -ne $renderer.CreationDate){throw '进程身份变化，停止注入'}
 # 只结束本脚本独立配置实例的已核验渲染子进程。
 Stop-Process -Id $renderer.ProcessId -Force
 $dialog=[IntPtr]::Zero
 $deadline=[DateTime]::UtcNow.AddSeconds(20)
 while([DateTime]::UtcNow -lt $deadline){
  $dialog=[DBFolioRecoveryProbe]::FindDialog([uint32]$taskProcess.Id)
  [uint32]$dialogProcess=0
  if($dialog -ne [IntPtr]::Zero){[void][DBFolioRecoveryProbe]::GetWindowThreadProcessId($dialog,[ref]$dialogProcess);if($dialogProcess -eq $taskProcess.Id){break}}
  Start-Sleep -Milliseconds 150
 }
 if($dialog -eq [IntPtr]::Zero -or $dialogProcess -ne $taskProcess.Id){throw '未检测到本进程原生恢复确认框'}
 $logs=Get-ChildItem -LiteralPath (Join-Path $taskProfile 'logs') -File
 if(-not($logs|Select-String -Pattern 'WebView 进程异常')){throw '未记录原生崩溃事件'}
 if((Get-Item -LiteralPath $marker).LastWriteTimeUtc -ne $readyTime){throw '未确认时发生自动重载'}
 [ordered]@{version=$ready.version;rendererFailureLogged=$true;nativeRecoveryDialog=$true;reloadRequiresConfirmation=$true;isolatedProfile=$taskProfile;actualOomReproduced=$false}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $taskOutput 'result.json') -Encoding UTF8
 Write-Output "原生渲染退出日志与确认恢复通过（受控终止，不是真实 OOM）：$taskOutput"
}finally{
 if($taskProcess.Id -and -not $taskProcess.HasExited){$taskProcess.Kill();$taskProcess.WaitForExit()}
 if($taskErr){[IO.File]::WriteAllText((Join-Path $taskOutput 'stderr.txt'),$taskErr.GetAwaiter().GetResult())}
 if($taskOut){[IO.File]::WriteAllText((Join-Path $taskOutput 'stdout.txt'),$taskOut.GetAwaiter().GetResult())}
}
