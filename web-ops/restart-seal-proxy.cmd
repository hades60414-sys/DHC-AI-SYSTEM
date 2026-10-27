@echo off
REM Restart only the seal-proxy (127.0.0.1:3002) so a code change takes effect. Started through Task Scheduler
REM so the process is not a child of whatever ran this (the Claude app kills its children on restart).
REM Open websocket connections through the tunnel drop for a few seconds; CloudCLI itself is untouched.
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*seal-proxy.js*' } | Select-Object -ExpandProperty ProcessId"`) do (
  echo Killing seal-proxy PID %%p
  taskkill /PID %%p /F >nul
)
schtasks /Create /TN CC-SealProxy-Once /TR "\"D:\TAS\cc-web\run-seal-proxy.cmd\"" /SC ONCE /ST 23:59 /F >nul
schtasks /Run /TN CC-SealProxy-Once >nul
ping -n 4 127.0.0.1 >nul
schtasks /Delete /TN CC-SealProxy-Once /F >nul
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri http://127.0.0.1:3002/health -UseBasicParsing -TimeoutSec 3 } catch { if ($_.Exception.Response.StatusCode.value__ -eq 403) { exit 0 } }; exit 1" >nul 2>&1
if %errorlevel%==0 (echo [OK] seal-proxy is back on 3002) else (echo [ERROR] seal-proxy did not answer on 3002 & exit /b 1)
