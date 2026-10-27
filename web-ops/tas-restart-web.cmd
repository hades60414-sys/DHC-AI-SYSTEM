@echo off
REM srv-main: restart the CloudCLI loop so start-cc-web.cmd re-reads its env (restart-cloudcli.cmd only kills node; the loop keeps old env).
REM Kills the start-cc-web.cmd cmd loop and its CloudCLI node, then CC-Hosts-Autostart relaunches what is missing. Tunnel untouched.
REM Run through a one-off scheduled task so it is not a child of the CloudCLI shell it kills.
set "LOG=D:\TAS\cc-web\tas-restart-web.log"
echo %date% %time% start>>"%LOG%"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*start-cc-web.cmd*') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*cloudcli*dist-server*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }" >>"%LOG%" 2>&1
ping -n 4 127.0.0.1 >nul
schtasks /Run /TN CC-Hosts-Autostart >>"%LOG%" 2>&1
set /a tries=0
:wait
set /a tries+=1
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri http://127.0.0.1:3001/health -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
if %errorlevel%==0 goto up
if %tries% geq 40 (echo %time% [ERROR] not back in 120s>>"%LOG%" & exit /b 1)
ping -n 3 127.0.0.1 >nul
goto wait
:up
echo %date% %time% [OK] CloudCLI back>>"%LOG%"
