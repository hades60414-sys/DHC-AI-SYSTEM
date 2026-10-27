@echo off
REM srv-main: restart CloudCLI once no chat turn is running, then ask 中台小助手 once (assistant-verify).
REM restart-when-idle.cmd still points at %USERPROFILE%\cc-web from srv-old; on srv-main everything lives in D:\TAS\cc-web.
REM Idle = runstate.js reports ANY_RUNNING=false on two checks 30 s apart. Gives up after 6 hours.
REM Start it from a one-off scheduled task so the restart does not kill the chat that started it.
chcp 65001 >nul
setlocal
set "LOG=D:\TAS\cc-web\tas-restart-when-idle.log"
set /a idle=0
set /a checks=0
echo %date% %time% waiting for idle>>"%LOG%"
:check
set /a checks+=1
node D:\TAS\cc-web\runstate.js | findstr /c:"ANY_RUNNING=false" >nul
if %errorlevel%==0 (set /a idle+=1) else (set /a idle=0)
if %idle% geq 2 goto restart
if %checks% geq 720 (echo %date% %time% [GAVE UP] never idle for 6 hours>>"%LOG%" & exit /b 1)
ping -n 31 127.0.0.1 >nul
goto check
:restart
echo %date% %time% idle twice - restarting>>"%LOG%"
call D:\TAS\cc-web\tas-restart-web.cmd
echo %date% %time% restart exit %errorlevel%>>"%LOG%"
ping -n 11 127.0.0.1 >nul
node D:\TAS\cc-web\assistant-verify.cjs
echo %date% %time% verify exit %errorlevel%>>"%LOG%"
