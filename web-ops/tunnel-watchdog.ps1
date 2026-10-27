# cc-web tunnel-watchdog.ps1 (Windows PowerShell 5.1, ASCII only)
# Keeps a Cloudflare quick tunnel up for the local CloudCLI (127.0.0.1:3001) and publishes the
# current trycloudflare URL to the tasui Worker (/_tunnel-update, sealed with TASUI_EDGE_SEAL).
# Uses its own exe name (cloudflared-tasui.exe) so the backtest platform's watchdog never confuses the two.
$root = 'D:\TAS\cc-web'
$exe = Join-Path $root 'cloudflared-tasui.exe'
$tunnelLog = Join-Path $root 'tunnel.log'
$urlFile = Join-Path $root 'tunnel-url.txt'
$log = Join-Path $root 'watchdog.log'
$pidFile = Join-Path $root 'watchdog.pid'
$workerUrl = 'https://tas-ui.example.workers.dev/_tunnel-update'
$tasUrl = 'https://<worker>.<account>.workers.dev/_tunnel-update'   # 2026-10-20 TAS mailbox, until srv-main takes over
$appPort = 3001      # CloudCLI itself (auth status check)
$localPort = 3002    # seal-proxy in front of it; the tunnel points here
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Log($m) { ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) | Out-File -Append -Encoding utf8 $log }
if (Test-Path $pidFile) {
  $old = 0; [void][int]::TryParse((Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1), [ref]$old)
  # 2026-10-18: PID alone can be reused by an unrelated process; require its command line to be this script.
  $oldProc = $null; if ($old -gt 0) { $oldProc = Get-CimInstance Win32_Process -Filter "ProcessId=$old" -ErrorAction SilentlyContinue }
  if ($oldProc -and $oldProc.CommandLine -like '*tunnel-watchdog*') { Log "another watchdog running (pid $old), exiting"; exit 0 }
}
$PID | Out-File -Encoding ascii $pidFile
Log "watchdog start (pid $PID)"
$seal = (Get-Content (Join-Path $root '.env') -Encoding UTF8 | Where-Object { $_ -match '^TASUI_EDGE_SEAL=' } | Select-Object -First 1) -replace '^TASUI_EDGE_SEAL=', ''
if (-not $seal) { Log 'FATAL .env has no TASUI_EDGE_SEAL'; exit 1 }
$published = ''
$tunnelPid = 0
# Do not expose the app until its first (admin) user exists: open registration + public URL = takeover window.
$ready = $false
while (-not $ready) {
  try {
    $st = Invoke-RestMethod -Uri "http://127.0.0.1:$appPort/api/auth/status" -TimeoutSec 5
    if ($st.needsSetup -eq $false) { $ready = $true; Log 'app has its first user, opening tunnel' }
    else { Log 'app needsSetup=true: register the first user at http://127.0.0.1:3001 before the tunnel opens'; Start-Sleep -Seconds 30 }
  } catch { Log ("app not reachable yet: " + $_.Exception.Message); Start-Sleep -Seconds 15 }
}
while ($true) {
  try {
    $alive = ($tunnelPid -gt 0) -and (Get-Process -Id $tunnelPid -ErrorAction SilentlyContinue)
    if (-not $alive) {
      Log 'tunnel not running, starting'
      if (Test-Path $tunnelLog) { Clear-Content $tunnelLog -ErrorAction SilentlyContinue }
      # 2026-10-22: http2 (TCP) instead of the default QUIC (UDP); QUIC timed out for 20 min on 10-22 08:31-08:52.
      $p = Start-Process -FilePath $exe -ArgumentList @('tunnel', '--url', "http://127.0.0.1:$localPort", '--protocol', 'http2', '--logfile', $tunnelLog, '--loglevel', 'info') -WindowStyle Hidden -PassThru
      $tunnelPid = $p.Id
      $published = ''
      Start-Sleep -Seconds 8
    }
    # 2026-10-18: once the URL is published, stop scanning the log (published is reset to '' when the tunnel restarts).
    if (($published -eq '') -and (Test-Path $tunnelLog)) {
      $m = Select-String -Path $tunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -Last 1
      if ($m) {
        $url = $m.Matches[0].Value
        if ($url -ne $published) {
          $url | Out-File -Encoding ascii $urlFile
          try {
            $resp = Invoke-RestMethod -Method Post -Uri $workerUrl -Headers @{ 'x-tasui-seal' = $seal } -Body $url -ContentType 'text/plain'
            Log "published $url -> $resp"
            $published = $url
            try { $r2 = Invoke-RestMethod -Method Post -Uri $tasUrl -Headers @{ 'x-tasui-seal' = $seal } -Body $url -ContentType 'text/plain'; Log "published to TAS -> $r2" } catch { Log ('TAS publish failed: ' + $_.Exception.Message) }
          } catch { Log ("publish failed: " + $_.Exception.Message) }
        }
      }
    }
  } catch { Log ("loop error: " + $_.Exception.Message) }
  Start-Sleep -Seconds 30
}
