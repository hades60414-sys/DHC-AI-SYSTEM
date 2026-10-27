# health-check.ps1 (Windows PowerShell 5.1, ASCII only) - run every 5 min by Scheduled Task CC-Hosts-HealthCheck.
# Checks the CC Web UI stack and every Discord host listed in autostart.vbs. If anything is missing it does a
# clean restart of ALL hosts through the CC-Hosts-Autostart task (so nothing is a child of the Claude app).
# Rate-limited to one restart per 10 minutes. Log: D:\TAS\cc-hosts\health-check.log
# 2026-10-01: also checks the public URL end to end (see below); -Force restarts even if every part looks alive
# (used by morning-check.ps1 when the public URL stays down after a new tunnel).
param([switch]$Force)
$root = 'D:\TAS\cc-hosts'
$log = Join-Path $root 'health-check.log'
$stamp = Join-Path $root 'health-check.last-restart'
function Log($m) { ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) | Out-File -Append -Encoding utf8 $log }
function Http([string]$url) { try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 8; return [int]$r.StatusCode } catch { try { return [int]$_.Exception.Response.StatusCode.value__ } catch { return 0 } } }

$problems = @()
if ((Http 'http://127.0.0.1:3001/health') -ne 200) { $problems += 'cloudcli(3001)' }
if ((Http 'http://127.0.0.1:3002/health') -ne 403) { $problems += 'seal-proxy(3002)' }   # 403 = alive but unsealed, expected
if (-not (Get-Process -Name 'cloudflared-tasui' -ErrorAction SilentlyContinue)) { $problems += 'tunnel' }
$procs = Get-CimInstance Win32_Process
if (-not ($procs | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -match 'cc-web\\tunnel-watchdog\.ps1' })) { $problems += 'tunnel-watchdog' }
$expectedDiscord = (Select-String -Path (Join-Path $root 'autostart.vbs') -Pattern 'start-host\.cmd|start-discord-host\.cmd' | Measure-Object).Count
$liveDiscord = ($procs | Where-Object { $_.Name -eq 'claude.exe' -and $_.CommandLine -match '--channels' } | Measure-Object).Count
if ($liveDiscord -lt $expectedDiscord) { $problems += "discord($liveDiscord/$expectedDiscord)" }

if ($Force) { $problems += 'forced' }
# Valve (2026-10-01, second review): after WE killed the tunnel for a new one, a missing cloudflared is tunnel-watchdog's job
# (it retries every ~30 s). If the quick-tunnel service itself is down, restarting everything cannot help and would kill
# running sessions every 10 min, so while our kill has not recovered (flag 1 or 2; the next public 200 sets it to 0) a
# problem list of only 'tunnel' is left alone. A tunnel that dies on its own (flag 0) is handled as before.
$killFlag = Join-Path $root 'health-check.tunnel-killed'
$killed = '0'; if (Test-Path $killFlag) { $killed = [string](Get-Content $killFlag -ErrorAction SilentlyContinue | Select-Object -First 1) }
if (-not $Force -and $problems.Count -eq 1 -and $problems[0] -eq 'tunnel' -and ($killed -eq '1' -or $killed -eq '2')) {
  if ($killed -eq '1') { Log 'tunnel process missing after our new tunnel - tunnel-watchdog keeps retrying; no full restart until the public URL works again'; '2' | Out-File -Encoding ascii $killFlag }
  exit 0
}
# Valve (2026-10-22): only seal-proxy down = someone is restarting it, or it crashed alone. Restarting everything kills
# running chats and subagents (it happened at 10:34), so restart just seal-proxy; CloudCLI and its sessions stay up.
if (-not $Force -and $problems.Count -eq 1 -and $problems[0] -eq 'seal-proxy(3002)') {
  Start-Sleep -Seconds 20
  if ((Http 'http://127.0.0.1:3002/health') -eq 403) { Log 'seal-proxy(3002) was down briefly and came back on its own'; exit 0 }
  Log 'DOWN seal-proxy(3002) only - restarting seal-proxy alone (chats untouched)'
  & cmd.exe /c 'D:\TAS\cc-web\restart-seal-proxy.cmd' *> $null
  if ((Http 'http://127.0.0.1:3002/health') -eq 403) { Log 'seal-proxy back on 3002'; exit 0 }
  Log 'seal-proxy did not come back alone - falling through to full restart'
}
if ($problems.Count -eq 0) {
  # Every local part can be alive while the quick tunnel itself is broken: Cloudflare then answers 502/503/504/530.
  # After 3 such runs in a row (~15 min) kill cloudflared-tasui; tunnel-watchdog.ps1 starts a new tunnel and republishes it
  # within ~30s. At most one new tunnel per 60 min. No answer at all (code 0: internet/DNS/Cloudflare down) or any other
  # code never touches the tunnel: a new quick tunnel cannot be requested then, and a dying cloudflared would make the
  # local check above see "tunnel" missing and restart everything (verified 2026-10-01). morning-check.ps1 escalates once a day.
  $e2eFile = Join-Path $root 'health-check.e2e-fails'
  # 2026-10-21 card g: codes other than 200 and the tunnel errors (500 = Worker error such as the KV quota, 0 = no answer)
  # used to exit without a trace. Log the first check of each streak and the recovery; actions are unchanged.
  $otherFile = Join-Path $root 'health-check.public-other'
  $prevOther = ''; if (Test-Path $otherFile) { $prevOther = [string](Get-Content $otherFile -ErrorAction SilentlyContinue | Select-Object -First 1) }
  $fails = 0; if (Test-Path $e2eFile) { [void][int]::TryParse((Get-Content $e2eFile -ErrorAction SilentlyContinue | Select-Object -First 1), [ref]$fails) }
  $code = Http 'https://<worker>.<account>.workers.dev/health'
  if ($code -eq 200) {
    if ($fails -gt 0) { Log "public URL ok again (after $fails tunnel-error check(s))"; '0' | Out-File -Encoding ascii $e2eFile }
    if ($killed -ne '0') { '0' | Out-File -Encoding ascii $killFlag }
    if ($prevOther -ne '' -and $prevOther -ne '200') { Log "public URL ok again (after code $prevOther)"; '200' | Out-File -Encoding ascii $otherFile }
    exit 0
  }
  if (@(502, 503, 504, 530) -notcontains $code) {   # not a tunnel error: leave the tunnel alone
    if ($prevOther -ne [string]$code) { Log "public URL answers $code (not a tunnel error; tunnel left alone)"; [string]$code | Out-File -Encoding ascii $otherFile }
    exit 0
  }
  $fails++; $fails | Out-File -Encoding ascii $e2eFile
  if ($fails -eq 1) { Log "public URL answers $code (tunnel error; local parts alive)" }
  if ($fails -lt 3) { exit 0 }
  $tStamp = Join-Path $root 'health-check.last-tunnel-restart'
  $lastT = 0; if (Test-Path $tStamp) { [void][long]::TryParse((Get-Content $tStamp -ErrorAction SilentlyContinue | Select-Object -First 1), [ref]$lastT) }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  if (($now - $lastT) -lt 3600) { if ($fails -eq 3) { Log 'public URL still down after a new tunnel - waiting (next new tunnel after 60 min)' }; exit 0 }
  Log "public URL down $fails checks in a row - starting a new tunnel"
  '1' | Out-File -Encoding ascii $killFlag   # before the kill, so the next run already sees it
  Get-Process -Name 'cloudflared-tasui' -ErrorAction SilentlyContinue | Stop-Process -Force
  $now | Out-File -Encoding ascii $tStamp; '0' | Out-File -Encoding ascii $e2eFile
  exit 0
}
$last = 0; if (Test-Path $stamp) { [void][long]::TryParse((Get-Content $stamp -ErrorAction SilentlyContinue | Select-Object -First 1), [ref]$last) }
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
if (($now - $last) -lt 600) { Log ("DOWN " + ($problems -join ',') + " - restart suppressed (last restart " + ($now - $last) + "s ago)"); exit 0 }
Log ("DOWN " + ($problems -join ',') + " - restarting all hosts")
# Clean restart: stop every CC host process, then let Task Scheduler start them (never children of the Claude app).
$kill = $procs | Where-Object {
  ($_.Name -eq 'cmd.exe' -and $_.CommandLine -match 'start-cc-web\.cmd|start-host\.cmd|start-discord-host\.cmd') -or
  ($_.Name -eq 'claude.exe' -and $_.CommandLine -match '--channels') -or
  ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'cloudcli|seal-proxy\.js') -or
  ($_.Name -eq 'cloudflared-tasui.exe') -or
  ($_.Name -eq 'powershell.exe' -and $_.CommandLine -match 'cc-web\\tunnel-watchdog\.ps1')
}
foreach ($p in $kill) { & taskkill /PID $p.ProcessId /T /F *> $null }
Start-Sleep -Seconds 3
& schtasks /Run /TN CC-Hosts-Autostart *> $null
$now | Out-File -Encoding ascii $stamp
Log 'restart triggered via CC-Hosts-Autostart'
