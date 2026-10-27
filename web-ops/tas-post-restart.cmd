@echo off
REM srv-main 10/21: runs as its own scheduled task (TAS-PostRestart), started by tas-restart-fast.cmd just before the kill.
REM Waits for the old server to go down and the new one to answer, then asks 中台小助手 once and publishes pending release notes.
chcp 65001 >nul
setlocal
set "LOG=D:\TAS\cc-web\tas-restart-when-idle.log"
ping -n 8 127.0.0.1 >nul
set /a tries=0
:wait
set /a tries+=1
curl -s -o nul -m 3 http://127.0.0.1:3001/health && goto up
if %tries% geq 60 (echo %date% %time% [post] [ERROR] CloudCLI not back in 3 minutes>>"%LOG%" & exit /b 1)
ping -n 4 127.0.0.1 >nul
goto wait
:up
echo %date% %time% [post] CloudCLI back>>"%LOG%"
ping -n 6 127.0.0.1 >nul
node D:\TAS\cc-web\assistant-verify.cjs
set "RC=%errorlevel%"
REM node can leave the console on another code page; the Chinese %date% then fails to echo (verify line went missing 10-21).
chcp 65001 >nul
echo %date% %time% verify exit %RC%>>"%LOG%"
set "USERPROFILE=D:\TAS"
node D:\TAS\cc-web\release-notes.cjs restarted >>"%LOG%" 2>&1
set "RC=%errorlevel%"
chcp 65001 >nul
echo %date% %time% [post] release notes exit %RC%>>"%LOG%"
REM One-off checks queued by whoever asked for the restart: each post-restart-once*.cmd runs once, then moves to done.
for %%F in ("D:TAScc-webpost-restart-once*.cmd") do (
  echo %date% %time% [post] once %%~nxF>>"%LOG%"
  call "%%F" >>"%LOG%" 2>&1
  chcp 65001 >nul
  if not exist "D:TAScc-webpost-restart-oncedone" mkdir "D:TAScc-webpost-restart-oncedone"
  move /y "%%F" "D:TAScc-webpost-restart-oncedone\" >nul
)
