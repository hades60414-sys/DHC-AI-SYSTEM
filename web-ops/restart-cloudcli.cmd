@echo off
REM Restart only the CloudCLI node process of DHC CLI (tunnel / seal-proxy / watchdog untouched).
REM start-cc-web.cmd's loop relaunches CloudCLI ~5s after the process exits, picking up new dist-server files.
REM Running sessions are aborted by this - check nothing is mid-run first (node %USERPROFILE%\cc-web\runstate.js).
setlocal
REM 2026-10-18: when called by restart-when-idle (RESTART_REQUIRE_IDLE=1), re-check right before the kill and exit 2 if a claude/codex run exists.
REM Direct callers (deid-cutover, deploy-nightqueue, ...) do not set it and behave as before.
if not "%RESTART_REQUIRE_IDLE%"=="1" goto skipguard
powershell -NoProfile -Command "$n = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*cloudcli*dist-server*' }); if ($n.Count -eq 0) { exit 99 }; $ids = @($n | ForEach-Object { $_.ProcessId }); $busy = @(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'claude.exe' -or $_.Name -eq 'codex.exe') -and ($ids -contains $_.ParentProcessId) }); exit $busy.Count"
if %errorlevel% EQU 0 goto skipguard
if %errorlevel% EQU 99 goto skipguard
echo [BUSY] a claude/codex run started - not restarting
exit /b 2
:skipguard
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*cloudcli*dist-server*' } | Select-Object -ExpandProperty ProcessId"`) do (
  echo Killing CloudCLI node PID %%p
  taskkill /PID %%p /T /F >nul
)
echo Waiting for http://127.0.0.1:3001/health ...
set /a tries=0
:wait
set /a tries+=1
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri http://127.0.0.1:3001/health -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
if %errorlevel%==0 goto up
if %tries% geq 40 (echo [ERROR] server did not come back in 60s & exit /b 1)
ping -n 3 127.0.0.1 >nul
goto wait
:up
echo [OK] CloudCLI is back.
REM 2026-09-27: the live frontend is whatever the clone last built (every deploy copies clone dist -> cc-host dist),
REM so re-copying it after a restart can never roll the UI back. Staged copies under cc-web\stage-* are history only.
set "CLONE_DIST=%USERPROFILE%\ai-tools\_scans\src\claudecodeui\dist"
if exist "%CLONE_DIST%\index.html" (
  xcopy /E /Y /Q "%CLONE_DIST%" "%USERPROFILE%\cc-host\node_modules\@cloudcli-ai\cloudcli\dist\" >nul
  echo [OK] frontend bundle re-synced from the clone build - users reload the page.
)
REM 2026-10-13: release notes marked "pending": "restart" go public only now, stamped with this restart time.
node "%USERPROFILE%\cc-web\release-notes.cjs" restarted
