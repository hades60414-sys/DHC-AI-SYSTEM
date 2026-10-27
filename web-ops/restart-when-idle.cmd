@echo off
REM DHC CLI: restart CloudCLI only once nothing is running, so no chat turn or background subagent gets cut off.
REM Idle = the CloudCLI node process has no claude.exe / codex.exe child, on two checks one minute apart.
REM Gives up after 12 hours without an idle moment. If CloudCLI is not running at all, there is nothing to do:
REM start-cc-web.cmd loads the current dist-server files whenever it starts it.
REM Start it with restart-when-idle-detached.cmd (Task Scheduler): run from inside a DHC CLI chat, the restart
REM would kill this script together with the chat.
REM 2026-10-01: loads the background-subagent light (dist-server files already in place, backups *.bak-20261001).
REM Log: %USERPROFILE%\cc-web\restart-when-idle.log
chcp 65001 >nul
setlocal
set "LOG=%USERPROFILE%\cc-web\restart-when-idle.log"
set /a idle=0
set /a checks=0
echo [%date% %time%] waiting for CloudCLI to go idle >> "%LOG%"
:check
set /a checks+=1
powershell -NoProfile -Command "$n = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*cloudcli*dist-server*' }); if ($n.Count -eq 0) { exit 99 }; $ids = @($n | ForEach-Object { $_.ProcessId }); $busy = @(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'claude.exe' -or $_.Name -eq 'codex.exe') -and ($ids -contains $_.ParentProcessId) }); exit $busy.Count"
set "busy=%errorlevel%"
if "%busy%"=="99" (
  echo [%date% %time%] CloudCLI is not running - it loads the new files when it starts. Nothing to do. >> "%LOG%"
  exit /b 0
)
if "%busy%"=="0" (set /a idle+=1) else (set /a idle=0)
if %idle% geq 2 goto restart
if %checks% geq 720 (
  echo [%date% %time%] [GAVE UP] never idle for 12 hours - CloudCLI not restarted >> "%LOG%"
  exit /b 1
)
ping -n 61 127.0.0.1 >nul
goto check
:restart
REM 2026-10-18: one last idle check right before the kill; if something started meanwhile, go back to waiting.
powershell -NoProfile -Command "$n = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*cloudcli*dist-server*' }); if ($n.Count -eq 0) { exit 99 }; $ids = @($n | ForEach-Object { $_.ProcessId }); $busy = @(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'claude.exe' -or $_.Name -eq 'codex.exe') -and ($ids -contains $_.ParentProcessId) }); exit $busy.Count"
set "busy=%errorlevel%"
if not "%busy%"=="0" (
  echo [%date% %time%] became busy again right before restart ^(code %busy%^) - back to waiting >> "%LOG%"
  set /a idle=0
  if %checks% geq 720 (echo [%date% %time%] [GAVE UP] never idle for 12 hours - CloudCLI not restarted >> "%LOG%" & exit /b 1)
  ping -n 61 127.0.0.1 >nul
  goto check
)
echo [%date% %time%] idle on two checks in a row - restarting CloudCLI >> "%LOG%"
set "RESTART_REQUIRE_IDLE=1"
call "%USERPROFILE%\cc-web\restart-cloudcli.cmd" >> "%LOG%" 2>&1
set "rc=%errorlevel%"
set "RESTART_REQUIRE_IDLE="
if "%rc%"=="2" (
  echo [%date% %time%] restart-cloudcli saw a busy session at the last moment - back to waiting >> "%LOG%"
  set /a idle=0
  if %checks% geq 720 (echo [%date% %time%] [GAVE UP] never idle for 12 hours - CloudCLI not restarted >> "%LOG%" & exit /b 1)
  ping -n 61 127.0.0.1 >nul
  goto check
)
echo [%date% %time%] finished, exit %rc% >> "%LOG%"
