# morning-check.ps1 (Windows PowerShell 5.1, ASCII only) - run daily at 06:00 (07:00 until 2026-10-20) by Scheduled Task CC-Hosts-MorningCheck. 2026-10-01.
# 1) End-to-end check of the DHC CLI web path (tasui Worker -> quick tunnel -> seal-proxy -> CloudCLI) and repair if down:
#    local parts down -> health-check.ps1 (clean restart); only the tunnel broken -> new tunnel; still down -> forced clean restart.
# 2) One tiny Claude call so the 5-hour usage window starts now (06:00 -> resets 11:00). If a window is still open and ends
#    within 150 min, wait for it to end first; if it ends later than that, skip (the reset time cannot be moved).
# 3) Report only: age of the newest RAGENT (srv-db agent) heartbeat.
# Log: morning-check.log (one line per step); last run: morning-check.last.json
# 2026-10-24: sidebar shield warnings (cc-web\alert.cjs, de-duplicated by key) when: public URL still down after repair, srv-db or srv-rag (RAG1)
#    heartbeat older than -HbLimit minutes (default 120), CC-ColdSync last result non-zero. Local UI only; no Discord or other external message.
# Test: -DryRun (no repair, no ping, alerts are only logged), -HealthUrl <url> (simulate a broken public URL), -NoPing, -PingNow (ping without waiting),
#    -HbLimit <min> (e.g. 1 simulates stale heartbeats).
param([switch]$DryRun, [switch]$NoPing, [switch]$PingNow, [string]$HealthUrl = 'https://<worker>.<account>.workers.dev/health', [int]$HbLimit = 120)
$root = 'D:\TAS\cc-hosts'
$log = Join-Path $root 'morning-check.log'
$lastFile = Join-Path $root $(if ($DryRun) { 'morning-check.last-dryrun.json' } else { 'morning-check.last.json' })   # a dry run never overwrites the real result
$base = 'https://<worker>.<account>.workers.dev'
$claude = 'D:\TAS\cc-host\node_modules\@anthropic-ai\claude-code\bin\claude.exe'
$tokFile = 'C:\Users\demo\.tas\claude-token.txt'; if (Test-Path $tokFile) { $env:CLAUDE_CODE_OAUTH_TOKEN = (Get-Content $tokFile -TotalCount 1).Trim() }
$assets = Join-Path $env:USERPROFILE '.cloudcli\assets'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Log($m) { ("{0} {1}{2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $(if ($DryRun) { '[dry-run] ' } else { '' }), $m) | Out-File -Append -Encoding utf8 $log }
# Sidebar shield warning (alert.cjs de-duplicates by key while unresolved). Source stays ASCII: Chinese text goes in as \u escapes.
function U([string]$s) { [regex]::Unescape($s) }
function Alert([string]$key, [string]$title, [string]$detail) {
  if ($DryRun) { Log "ALERT would be raised (dry-run, not sent): $key"; return }
  try { $o = & 'D:\TAS\node\node.exe' 'D:\TAS\cc-web\alert.cjs' add warn $title $detail --source (U '\u6668\u6AA2') --key $key 2>&1 | Out-String; Log ("ALERT " + $key + ": " + $o.Trim()) } catch { Log "ALERT $key failed: $_" }
}
function Http([string]$url, [int]$t = 15) { try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $t; return [int]$r.StatusCode } catch { try { return [int]$_.Exception.Response.StatusCode.value__ } catch { return 0 } } }
function E2E { $c = 0; for ($i = 0; $i -lt 3; $i++) { $c = Http $HealthUrl; if ($c -eq 200) { return 200 }; Start-Sleep -Seconds 20 }; return $c }
function LocalOk { ((Http 'http://127.0.0.1:3001/health' 8) -eq 200) -and ((Http 'http://127.0.0.1:3002/health' 8) -eq 403) }
# Usage numbers from the same endpoint the DHC CLI sidebar uses (the token stays on this machine).
# The first request after a quiet period returns the old numbers marked stale and triggers a refresh, so retry.
# 2026-10-12: asked from the local seal-proxy with its edge seal, because the public URL has needed a login since 2026-10-08.
$seal = ''; try { $seal = ([regex]::Match((Get-Content 'D:\TAS\cc-web\.env' -Raw), '(?m)^TASUI_EDGE_SEAL=(.+)$')).Groups[1].Value.Trim() } catch {}
function Usage { for ($i = 0; $i -lt 4; $i++) { try { $u = Invoke-RestMethod -Uri 'http://127.0.0.1:3002/_usage' -Headers @{ 'x-tasui-edge' = $seal } -TimeoutSec 15 } catch { $u = $null }; if ($u -and $u.session -and -not $u.stale) { return $u }; Start-Sleep -Seconds 10 }; return $null }
function ResetsAt($u) { if ($u -and $u.session -and $u.session.resets_at) { return [DateTimeOffset]::Parse($u.session.resets_at).LocalDateTime }; return $null }
function Ping([string]$model) {
  $out = Join-Path $root 'morning-check.ping.json'
  $env:DISABLE_AUTOUPDATER = '1'
  # One argument string so the empty --tools value survives (PowerShell 5.1 drops empty native arguments).
  $p = Start-Process -FilePath $claude -WorkingDirectory $root -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out `
    -ArgumentList ('-p ping --model ' + $model + ' --tools "" --strict-mcp-config --no-session-persistence --disable-slash-commands --system-prompt "Reply with the single word OK." --output-format json')
  $ok = $false; try { $j = Get-Content $out -Raw | ConvertFrom-Json; $ok = (-not $j.is_error) -and ($j.result -match 'OK') } catch {}
  return [pscustomobject]@{ model = $model; exit = $p.ExitCode; ok = $ok; at = Get-Date }
}

$r = [ordered]@{ started = (Get-Date).ToString('s'); dry_run = [bool]$DryRun; public_url = $null; repair = 'none'; public_url_after = $null; window_before = $null; ping = $null; window_after = $null; ragent_heartbeat_min = $null; ok = $false }
Log 'morning check start'

# 1) public URL. Only tunnel errors (Cloudflare answers 502/503/504/530) get a new tunnel: with no answer at all a new
# quick tunnel cannot be requested, and a dying cloudflared would make health-check.ps1 restart everything (verified 2026-10-01).
$code = E2E
$r.public_url = $code
$stampFile = Join-Path $root 'health-check.last-restart'
function StampOf { if (Test-Path $stampFile) { return (Get-Content $stampFile -ErrorAction SilentlyContinue | Select-Object -First 1) }; return '' }
if ($code -eq 200) { Log 'public URL ok (200)' }
elseif (-not (LocalOk)) {
  $r.repair = 'clean restart (local parts down)'
  Log "public URL $code, local parts down -> health-check.ps1 clean restart"
  if (-not $DryRun) { & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'health-check.ps1'); Start-Sleep -Seconds 120 }
  $code = E2E; $r.public_url_after = $code
}
elseif (@(502, 503, 504, 530) -notcontains $code) {
  $r.repair = 'none (no tunnel error)'
  Log "public URL $code with local parts alive: internet, DNS or Cloudflare problem - nothing to repair from here"
}
else {
  $r.repair = 'new tunnel'
  Log "public URL $code (tunnel error), local parts alive -> new tunnel (tunnel-watchdog starts one and republishes it)"
  # flag first: while this new tunnel has not worked yet, health-check.ps1 will not restart everything just because cloudflared is missing
  if (-not $DryRun) { '1' | Out-File -Encoding ascii (Join-Path $root 'health-check.tunnel-killed'); Get-Process -Name 'cloudflared-tasui' -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 90 }
  $code = E2E
  if ($code -ne 200) {
    $before = StampOf
    Log "public URL still $code -> forced clean restart"
    if (-not $DryRun) { & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'health-check.ps1') -Force; Start-Sleep -Seconds 120 }
    $r.repair += $(if (-not $DryRun -and (StampOf) -eq $before) { ' + forced clean restart SUPPRESSED (a restart ran in the last 10 min)' } else { ' + forced clean restart' })
    $code = E2E
  }
  $r.public_url_after = $code
}
if ($r.public_url_after -ne $null) { Log ("public URL after repair: " + $code + $(if ($code -eq 200) { ' (fixed)' } else { ' (STILL DOWN - the 5-min health check keeps trying)' })) }

if ($code -ne 200) { Alert 'morning-public-url-down' (U '\u516C\u958B\u7DB2\u5740\u4FEE\u5FA9\u5F8C\u4ECD\u7136\u4E0D\u901A') ((U '\u6668\u6AA2\u4FEE\u5FA9\u5F8C\u516C\u958B\u7DB2\u5740\u4ECD\u7121\u6CD5\u9023\u7DDA\uFF0C5 \u5206\u9418\u5065\u5EB7\u6AA2\u67E5\u6703\u6301\u7E8C\u5617\u8A66\u3002') + " HTTP $code") }

# 2) start the 5-hour usage window
if (-not $NoPing -and -not $DryRun) {
  $u = Usage
  $until = ResetsAt $u
  $r.window_before = $(if ($u) { $(if ($until) { $until.ToString('s') } else { 'none open' }) } else { 'unknown (usage not readable)' })
  $go = $true
  if ($until -and $until -gt (Get-Date) -and -not $PingNow) {
    $mins = [int](($until - (Get-Date)).TotalMinutes)
    if ($mins -le 150) { Log "usage window open until $($until.ToString('HH:mm')) -> wait $mins min, then start a new one"; Start-Sleep -Seconds ($mins * 60 + 90) }
    else { $go = $false; Log "usage window open until $($until.ToString('HH:mm')) (more than 150 min away) -> no ping, reset stays at that time" }
  }
  if ($go) {
    $p = Ping 'haiku'
    $r.ping = "$($p.model) exit=$($p.exit) ok=$($p.ok) at $($p.at.ToString('HH:mm:ss'))"
    Log ("claude ping: " + $r.ping)
    Start-Sleep -Seconds 150   # usage numbers are cached up to 2 min
    $u2 = Usage; $after = ResetsAt $u2
    # fall back to sonnet only when the numbers were readable and positively show no open window
    if ($u2 -and (-not $after -or $after -lt (Get-Date))) {
      Log 'no open usage window after the haiku ping -> one more ping with sonnet'
      $p = Ping 'sonnet'; $r.ping += " | $($p.model) exit=$($p.exit) ok=$($p.ok)"
      Start-Sleep -Seconds 150; $after = ResetsAt (Usage)
    }
    $r.window_after = $(if ($after) { $after.ToString('s') } elseif ($u2) { 'none open' } else { 'unknown (usage not readable)' })
    Log ("usage window now resets at " + $(if ($after) { $after.ToString('yyyy-MM-dd HH:mm') } else { 'unknown' }))
  }
} else { Log 'ping skipped (-NoPing or -DryRun)' }

# 3) RAGENT heartbeat age (report only; srv-db cannot be repaired from here)
$hb = Get-ChildItem -Path $assets -Filter '*-ragent-agent-heartbeat.cms.b64.txt' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($hb) { $r.ragent_heartbeat_min = [int]((Get-Date) - $hb.LastWriteTime).TotalMinutes; Log ("RAGENT last heartbeat " + $r.ragent_heartbeat_min + " min ago" + $(if ($r.ragent_heartbeat_min -gt 20) { ' (STALE: agent or network down on srv-db)' } else { '' })) }
else { Log 'RAGENT heartbeat: none found' }
if ($r.ragent_heartbeat_min -ne $null -and $r.ragent_heartbeat_min -gt $HbLimit) { Alert 'morning-hb-ragent-stale' (U 'srv-db \u4EE3\u7406\u7A0B\u5F0F\u5FC3\u8DF3\u8D85\u904E 2 \u5C0F\u6642') ((U 'srv-db \u6700\u65B0\u5FC3\u8DF3\u5728 {0} \u5206\u9418\u524D\uFF0C\u8ACB\u6AA2\u67E5 srv-db \u4EE3\u7406\u7A0B\u5F0F\u6216\u7DB2\u8DEF\u3002') -f $r.ragent_heartbeat_min) }

# 3b) srv-rag (RAG1) heartbeat age, same source as srv-db. 2026-10-24.
$hbj = Get-ChildItem -Path $assets -Filter '*-rag1-agent-heartbeat.cms.b64.txt' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$r.rag1_heartbeat_min = $(if ($hbj) { [int]((Get-Date) - $hbj.LastWriteTime).TotalMinutes } else { $null })
if ($hbj) { Log ("RAG1 (srv-rag) last heartbeat " + $r.rag1_heartbeat_min + " min ago" + $(if ($r.rag1_heartbeat_min -gt 20) { ' (STALE: agent or network down on srv-rag)' } else { '' })) } else { Log 'RAG1 (srv-rag) heartbeat: none found' }
if ($r.rag1_heartbeat_min -ne $null -and $r.rag1_heartbeat_min -gt $HbLimit) { Alert 'morning-hb-rag1-stale' (U 'srv-rag (RAG1) \u4EE3\u7406\u7A0B\u5F0F\u5FC3\u8DF3\u8D85\u904E 2 \u5C0F\u6642') ((U 'srv-rag \u6700\u65B0\u5FC3\u8DF3\u5728 {0} \u5206\u9418\u524D\uFF0C\u8ACB\u6AA2\u67E5 srv-rag \u662F\u5426\u958B\u6A5F\u4E14\u6709\u4EBA\u767B\u5165\u3002') -f $r.rag1_heartbeat_min) }

# 3c) CC-ColdSync last result (0 = ok; 267011 = never ran yet). 2026-10-24.
$r.coldsync_last_result = $null
try { $cs = Get-ScheduledTaskInfo -TaskName 'CC-ColdSync' -ErrorAction Stop; $r.coldsync_last_result = [int64]$cs.LastTaskResult } catch { Log "CC-ColdSync result unreadable: $_" }
if ($r.coldsync_last_result -ne $null) { Log ("CC-ColdSync last result: " + $r.coldsync_last_result) }
if ($r.coldsync_last_result -ne $null -and $r.coldsync_last_result -ne 0 -and $r.coldsync_last_result -ne 267011) { Alert 'morning-coldsync-failed' (U '\u51B7\u8A18\u61B6\u540C\u6B65 (CC-ColdSync) \u5931\u6557') ((U '\u6392\u7A0B\u4E0A\u6B21\u7D50\u679C\u78BC {0}\uFF0C\u8ACB\u770B stage-nas\\cold-mirror\\sched.log\u3002') -f $r.coldsync_last_result) }

# 4) Claude login on this machine (report only: signing in again needs a person -> cc-hosts\claude-relogin.cmd). 2026-10-12.
# The login runs out about 30 days after the last sign-in; Claude Code then empties the tokens and every DHC CLI turn fails.
$r.claude_login = 'unknown'
try {
  $o = (Get-Content (Join-Path $env:USERPROFILE '.claude\.credentials.json') -Raw -ErrorAction Stop | ConvertFrom-Json).claudeAiOauth
  if (-not $o -or -not $o.refreshToken) { $r.claude_login = 'LOGGED OUT' }
  elseif ($o.refreshTokenExpiresAt -gt 0) {
    $days = [int][math]::Ceiling(($o.refreshTokenExpiresAt - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) / 86400000)
    $r.claude_login = $(if ($days -le 0) { 'EXPIRED' } elseif ($days -le 7) { "EXPIRING in $days days" } else { "ok ($days days left)" })
  } else { $r.claude_login = 'ok' }
} catch {}
$loginWarn = $r.claude_login -match 'LOGGED OUT|EXPIRED|EXPIRING'
$loginDead = $loginWarn -and ($r.claude_login -notmatch 'EXPIRING')
Log ("claude login: " + $r.claude_login + $(if ($loginWarn) { ' -> run cc-hosts\claude-relogin.cmd on this machine' } else { '' }))

# 5) log rotation (copy + truncate when a log is over 5 MB, keep 3). 2026-10-24. Own log: cc-web\log-rotate.log
try { $lr = & 'D:\TAS\node\node.exe' 'D:\TAS\cc-web\log-rotate.cjs' $(if ($DryRun) { '--dry' }) 2>&1 | Out-String; Log ("log-rotate: " + $(if ($lr.Trim()) { $lr.Trim() -replace "`r?`n", ' | ' } else { 'nothing over 5 MB' })) } catch { Log "log-rotate failed: $_" }

$r.ok = ((($r.public_url -eq 200) -or ($r.public_url_after -eq 200)) -and -not $loginDead)
$r.finished = (Get-Date).ToString('s')
$r | ConvertTo-Json | Out-File -Encoding utf8 $lastFile
Log ('morning check end: ' + $(if ($r.ok) { 'OK' } elseif ($loginDead) { 'CLAUDE LOGIN ' + $r.claude_login } else { 'PUBLIC URL DOWN' }))
