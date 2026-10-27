@echo off
REM srv-main 10/21: restart CloudCLI as soon as nothing is running (idle-check.cjs: chats, background work, 中台小助手 replies).
REM   tas-restart-fast.cmd [sessionId-to-ignore]   -- pass the conversation that asked, it will be cut off by the restart.
REM Checks every 5 s, restarts after two idle checks in a row, logs who is busy every 5 minutes, gives up after 6 hours.
REM Post-restart checks run in their own scheduled task (TAS-PostRestart) so killing CloudCLI cannot cut them off.
REM Start this from a one-off scheduled task (highest privileges) so it is not a child of the CloudCLI it restarts.
chcp 65001 >nul
setlocal
set "LOG=D:\TAS\cc-web\tas-restart-when-idle.log"
set "EXCEPT="
if not "%~1"=="" set "EXCEPT=--except %~1"
set /a idle=0
set /a checks=0
echo %date% %time% [fast] waiting for idle %EXCEPT%>>"%LOG%"
:check
set /a checks+=1
for /f "delims=" %%L in ('node D:\TAS\cc-web\idle-check.cjs %EXCEPT%') do set "STATE=%%L"
if "%STATE:~0,4%"=="IDLE" (set /a idle+=1) else (set /a idle=0)
if %idle% geq 2 goto restart
set /a mark=checks %% 60
if %mark%==0 echo %date% %time% [fast] still waiting: %STATE%>>"%LOG%"
if %checks% geq 4320 (echo %date% %time% [fast] [GAVE UP] never idle for 6 hours: %STATE%>>"%LOG%" & exit /b 1)
ping -n 6 127.0.0.1 >nul
goto check
:restart
echo %date% %time% [fast] idle twice (%STATE%) - restarting>>"%LOG%"
schtasks /Run /TN TAS-PostRestart >nul 2>&1
call D:\TAS\cc-web\tas-restart-web.cmd
set "RC=%errorlevel%"
chcp 65001 >nul
echo %date% %time% [fast] restart exit %RC%>>"%LOG%"
