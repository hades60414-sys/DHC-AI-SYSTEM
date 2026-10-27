# Kill any node.exe whose committed memory exceeds the limit, and log its command line.
# Runs every minute from scheduled task CC-NodeMemGuard. Log: node-mem-guard.log
param([double]$LimitGB = 12)

$log = Join-Path $PSScriptRoot 'node-mem-guard.log'
$limit = [int64]($LimitGB * 1GB)

Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.PrivatePageCount -gt $limit } | ForEach-Object {
    $gb = [math]::Round($_.PrivatePageCount / 1GB, 1)
    $result = 'killed'
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch { $result = "kill failed: $($_.Exception.Message)" }
    $line = '{0} pid={1} parent={2} {3}GB {4} cmd={5}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $_.ProcessId, $_.ParentProcessId, $gb, $result, $_.CommandLine
    Add-Content -Path $log -Value $line -Encoding UTF8
}
