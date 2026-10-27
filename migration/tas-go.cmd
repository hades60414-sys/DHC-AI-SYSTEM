@echo off
REM TAS cutover on srv-main (2026-10-20). Run once from an elevated CMD (Run as administrator).
REM Puts the new agent controller files in place, patches checks, registers the scheduled tasks,
REM stops the local test copy and starts TAS for real; the tunnel watchdog then moves the public URLs to this machine.
setlocal
net session >nul 2>&1 || (echo [STOP] Please open CMD with "Run as administrator" and run this again. & exit /b 1)
set "MB=https://<worker>.<account>.workers.dev/api/assets/files"
set "N=D:\TAS\node\node.exe"
set "PATH=D:\TAS\node;%PATH%"
cd /d D:\TAS || (echo [STOP] D:\TAS not found & exit /b 1)

echo [1/6] Downloading tools and the cutover bundle...
curl -fsS -o D:\TAS\tas-pack.cjs %MB%/tas-pack.cjs || goto fail
curl -fsS -o D:\TAS\tas-patch-main.cjs %MB%/tas-patch-main.cjs || goto fail
"%N%" D:\TAS\tas-pack.cjs unpack %MB% tas-05ae9e3bb3 0000000000000000000000000000000000000000000000000000000000000000 D:\TAS\_go || goto fail

echo [2/6] Placing files and patching checks...
"%N%" D:\TAS\tas-patch-main.cjs || goto fail
powershell -NoProfile -Command "$p=[Environment]::GetEnvironmentVariable('Path','User'); if (-not $p) { $p='' }; if ($p -notlike '*D:\TAS\node*') { [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';D:\TAS\node').TrimStart(';'), 'User'); 'user PATH: added D:\TAS\node' } else { 'user PATH: already has D:\TAS\node' }"

echo [3/6] Stopping the local test copy...
wmic process where "name='cmd.exe' and commandline like '%%start-cc-web-local%%'" call terminate >nul 2>&1
wmic process where "name='cmd.exe' and commandline like '%%run-deid-proxy%%'" call terminate >nul 2>&1
for %%P in (3001 3002 3003) do for /f "tokens=5" %%i in ('netstat -ano ^| findstr /r /c:"127.0.0.1:%%P .*LISTENING"') do taskkill /pid %%i /t /f >nul 2>&1

echo [4/6] Registering scheduled tasks (run without logon)...
schtasks /create /f /tn CC-Hosts-Autostart /sc onstart /ru %USERNAME% /np /rl highest /tr "wscript.exe D:\TAS\cc-hosts\autostart.vbs" || goto fail
schtasks /create /f /tn CC-Hosts-HealthCheck /sc minute /mo 5 /ru %USERNAME% /np /rl highest /tr "D:\TAS\cc-hosts\health-check.cmd" || goto fail
schtasks /create /f /tn CC-Hosts-MorningCheck /sc daily /st 06:00 /ru %USERNAME% /np /rl highest /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\TAS\cc-hosts\morning-check.ps1" || goto fail
schtasks /create /f /tn CC-NodeMemGuard /sc minute /mo 1 /ru %USERNAME% /np /rl highest /tr "D:\TAS\cc-hosts\node-mem-guard.cmd" || goto fail
schtasks /create /f /tn TAS-Rotate /sc weekly /d MON /st 05:30 /ru %USERNAME% /np /rl highest /tr "D:\TAS\cc-hosts\tas-rotate.cmd rotate" || goto fail

echo [5/6] Starting TAS (about 90 seconds)...
schtasks /run /tn CC-Hosts-Autostart || goto fail
timeout /t 90 /nobreak >nul

echo [6/6] Checking...
curl -s -o nul -w "  local web:   %%{http_code}\n" http://127.0.0.1:3001/health
curl -s -o nul -w "  local de-id: %%{http_code} (404 is normal)\n" http://127.0.0.1:3003/
if exist D:\TAS\cc-web\tunnel-url.txt (set /p TUN=<D:\TAS\cc-web\tunnel-url.txt) else (set "TUN=none")
echo   this machine's tunnel: %TUN%
call D:\TAS\cc-hosts\tas-rotate.cmd status
curl -s -o nul -w "  public mailbox health: %%{http_code}\n" https://<worker>.<account>.workers.dev/health
echo.
echo DONE. If "target" above equals this machine's tunnel, TAS now runs here. Open the current front URL in a browser.
exit /b 0

:fail
echo.
echo [FAILED] at the step above. Take a photo of this window and send it to Claude.
exit /b 1
