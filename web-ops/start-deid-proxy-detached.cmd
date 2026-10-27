@echo off
REM Starts run-deid-proxy.cmd through Task Scheduler so it is not a child of whatever ran this (the Claude app kills
REM its children on restart). Does nothing when the proxy already answers.
"D:\TAS\node\node.exe" -e "fetch('http://127.0.0.1:3003/_deid/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
if not errorlevel 1 (echo [OK] deid-proxy already running on 3003 & exit /b 0)
schtasks /Create /TN CC-DeidProxy-Once /TR "cmd.exe /c start \"deid-proxy\" /min \"D:\TAS\cc-web\run-deid-proxy.cmd\"" /SC ONCE /ST 23:59 /F >nul
schtasks /Run /TN CC-DeidProxy-Once >nul
ping -n 5 127.0.0.1 >nul
schtasks /Delete /TN CC-DeidProxy-Once /F >nul
"D:\TAS\node\node.exe" -e "fetch('http://127.0.0.1:3003/_deid/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
if errorlevel 1 (echo [ERROR] deid-proxy did not answer on 3003 & exit /b 1)
echo [OK] deid-proxy is up on 3003
