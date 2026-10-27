# night-ping.ps1 (Windows PowerShell 5.1, ASCII only) - run daily at 01:00, 11:00, 16:00 (06:00 is the morning check) by Scheduled Task CC-Hosts-NightPing. 2026-10-22.
# 2026-10-27: no 21:00 ping. 5 h does not divide 24: a 21:00 window runs to 02:00, swallowing the 01:00 anchor every night.
# Leave 21:00-01:00 free so the 01:00 window can start on time; nightly Claude jobs belong inside 01:00-06:00 or after 06:00.
# One tiny Claude call so a 5-hour usage window starts at 01:00 and ends at 06:00. Night work (01:00-06:00) then lands
# inside this window instead of opening one at e.g. 02:00, and the 06:00 morning check can start the 06:00->11:00 window.
$root = 'D:\TAS\cc-hosts'
$log = Join-Path $root 'morning-check.log'
$claude = 'D:\TAS\cc-host\node_modules\@anthropic-ai\claude-code\bin\claude.exe'
$tokFile = 'C:\Users\demo\.tas\claude-token.txt'; if (Test-Path $tokFile) { $env:CLAUDE_CODE_OAUTH_TOKEN = (Get-Content $tokFile -TotalCount 1).Trim() }
$env:DISABLE_AUTOUPDATER = '1'
$out = Join-Path $root 'night-ping.json'
$slot = Get-Date -Format 'HH'
function Log($m) { ("{0} night ping {1}:00: {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $slot, $m) | Out-File -Append -Encoding utf8 $log }
# 2026-10-27: a ping at HH:00 lands exactly 5 h after the previous one, i.e. on the edge of the window it opened, and was
# often counted into that old window; the cycle then drifted (10-26/27 reset 13:30 instead of 11:00). Read the window
# first (same seal-proxy /_usage as the morning check) and, if it ends within 30 min, wait for it to end before pinging.
$seal = ''; try { $seal = ([regex]::Match((Get-Content 'D:\TAS\cc-web\.env' -Raw), '(?m)^TASUI_EDGE_SEAL=(.+)$')).Groups[1].Value.Trim() } catch {}
function ResetsAt { for ($i = 0; $i -lt 4; $i++) { try { $u = Invoke-RestMethod -Uri 'http://127.0.0.1:3002/_usage' -Headers @{ 'x-tasui-edge' = $seal } -TimeoutSec 15 } catch { $u = $null }; if ($u -and $u.session -and -not $u.stale) { if ($u.session.resets_at) { return [DateTimeOffset]::Parse($u.session.resets_at).LocalDateTime }; return $null }; Start-Sleep -Seconds 10 }; return $null }
$until = ResetsAt
if ($until -and $until -gt (Get-Date)) {
  $mins = [math]::Ceiling(($until - (Get-Date)).TotalMinutes)
  if ($mins -le 30) { Log "window open until $($until.ToString('HH:mm:ss')) -> wait $mins min"; Start-Sleep -Seconds ($mins * 60 + 90) }
  else { Log "window open until $($until.ToString('HH:mm')) (drifted, cannot move it) -> ping anyway" }
}
$p = Start-Process -FilePath $claude -WorkingDirectory $root -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out `
  -ArgumentList '-p ping --model haiku --tools "" --strict-mcp-config --no-session-persistence --disable-slash-commands --system-prompt "Reply with the single word OK." --output-format json'
$ok = $false; try { $j = Get-Content $out -Raw | ConvertFrom-Json; $ok = (-not $j.is_error) -and ($j.result -match 'OK') } catch {}
Log "haiku exit=$($p.ExitCode) ok=$ok"
Start-Sleep -Seconds 150   # usage numbers are cached up to 2 min
$after = ResetsAt
Log ("window now resets at " + $(if ($after) { $after.ToString('yyyy-MM-dd HH:mm') } else { 'unknown' }))
