# orphan-sweep.ps1 (Windows PowerShell 5.1, ASCII only) - run every 5 min from health-check.cmd. 2026-10-22.
# Kills Claude Code Bash-tool shells (command line has "shell-snapshots") whose parent process is gone.
# Cause: a backgrounded Bash call can outlive its session; the app then shows the conversation as still running.
# -MinAgeMin: only shells at least this old (default 10). -DryRun: log only. Log: D:\TAS\cc-hosts\orphan-sweep.log
param([int]$MinAgeMin = 10, [switch]$DryRun)
$log = 'D:\TAS\cc-hosts\orphan-sweep.log'
$all = Get-CimInstance Win32_Process
$alive = @{}; foreach ($p in $all) { $alive[[int]$p.ProcessId] = $true }
$cutoff = (Get-Date).AddMinutes(-$MinAgeMin)
foreach ($p in $all) {
  if ($p.Name -ne 'bash.exe' -or $p.CommandLine -notmatch 'shell-snapshots') { continue }
  if ($alive.ContainsKey([int]$p.ParentProcessId) -or $p.CreationDate -gt $cutoff) { continue }
  $cmd = ($p.CommandLine -replace '^.*eval ', '') ; if ($cmd.Length -gt 120) { $cmd = $cmd.Substring(0, 120) }
  if (-not $DryRun) { & taskkill /PID $p.ProcessId /T /F *> $null }
  ("{0} {1}kill {2} {3}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $(if ($DryRun) { 'dry ' } else { '' }), $p.ProcessId, $cmd) | Out-File -Append -Encoding utf8 $log
}
